import { randomUUID } from "node:crypto";
import { pool } from "@/lib/db";
import { lessonFromAnswer } from "@/lib/lessons";

export const MODES = ["dry_run", "review", "auto"] as const;
export type Mode = (typeof MODES)[number];

export function parseJobUrl(input: unknown): URL | null {
  try {
    const url = new URL(String(input));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

// Starts a GitHub Actions run; the worker claims whichever job is queued.
const ghHeaders = () => ({
  Authorization: `Bearer ${process.env.GH_DISPATCH_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

// True when a worker run is already waiting to start. That run drains the whole queue, so another dispatch
// would only start a second runner (apply.yml's concurrency group then cancels one of the pending runs).
async function workerPending(): Promise<boolean> {
  for (const status of ["queued", "pending", "waiting", "requested"]) {
    const r = await fetch(`https://api.github.com/repos/${process.env.GH_REPOSITORY}/actions/workflows/apply.yml/runs?status=${status}&per_page=1`, { headers: ghHeaders() }).catch(() => null);
    if (!r?.ok) return false; // Can't tell: dispatch anyway.
    if (((await r.json()) as { total_count?: number }).total_count) return true;
  }
  return false;
}

// Starts a GitHub Actions run unless one is already waiting. force=true always dispatches (the Run now button).
export async function dispatchWorker({ force = false }: { force?: boolean } = {}): Promise<boolean> {
  if (!process.env.GH_DISPATCH_TOKEN || !process.env.GH_REPOSITORY) {
    console.error("dispatchWorker: GH_DISPATCH_TOKEN or GH_REPOSITORY is not set");
    return false;
  }
  if (!force && await workerPending()) return true;
  try {
    const response = await fetch(`https://api.github.com/repos/${process.env.GH_REPOSITORY}/actions/workflows/apply.yml/dispatches`, {
      method: "POST",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: process.env.GH_REF || "main" }),
    });
    // GitHub's error body names the cause (bad credentials, missing Actions permission, unknown ref) and holds no secrets.
    if (!response.ok) console.error(`dispatchWorker: GitHub returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response.ok;
  } catch (error) {
    console.error("dispatchWorker: request failed", error instanceof Error ? error.message : error);
    return false;
  }
}

export async function killSwitchOn(): Promise<boolean> {
  const row = (await pool.query("SELECT value FROM settings WHERE key='kill_switch'")).rows[0];
  return row?.value === true;
}

export async function createJob(url: URL, mode?: string) {
  let chosen: Mode;
  if (mode && (MODES as readonly string[]).includes(mode)) chosen = mode as Mode;
  else chosen = ((await pool.query("SELECT value FROM settings WHERE key='default_mode'")).rows[0]?.value as Mode) || "review";
  if (await killSwitchOn()) throw new Error("The kill switch is on. Turn it off in Settings or send /resume.");
  const id = randomUUID();
  await pool.query("INSERT INTO jobs (id, application_url, mode) VALUES ($1, $2, $3)", [id, url.href, chosen]);
  const dispatched = await dispatchWorker();
  return { id, mode: chosen, status: "queued", dispatched };
}

// Kill switch: stops new runs and cancels everything in flight.
export async function setKillSwitch(on: boolean) {
  await pool.query("INSERT INTO settings (key, value) VALUES ('kill_switch', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [JSON.stringify(on)]);
  if (on) await pool.query("UPDATE jobs SET status='cancelled', note='Kill switch', updated_at=now() WHERE status IN ('queued','running','needs_user','awaiting_approval') AND submit_attempted_at IS NULL");
}

// Answers a question. A "lesson" answer (what you did after a handoff) also becomes a lesson candidate.
// If the job was parked waiting for this answer, it is re-queued (or, for a rejected approval, cancelled).
export async function answerQuestion(questionId: number, answer: string) {
  const r = await pool.query("UPDATE questions SET answer=$2, answered_at=now() WHERE id=$1 AND answer IS NULL RETURNING id, job_id, kind", [questionId, answer]);
  const row = r.rows[0] as { id: number; job_id: string; kind: string } | undefined;
  if (!row) return row;
  if (row.kind === "lesson") { await lessonFromAnswer(row.id, answer).catch(() => null); return row; }
  if (row.kind === "approval" && answer !== "Approve") {
    await pool.query("UPDATE jobs SET status='cancelled', note='You rejected the submission', checkpoint=NULL, updated_at=now() WHERE id=$1 AND checkpoint IS NOT NULL AND claimed_by IS NULL", [row.job_id]);
    return row;
  }
  const requeued = await pool.query("UPDATE jobs SET status='queued', updated_at=now() WHERE id=$1 AND checkpoint IS NOT NULL AND claimed_by IS NULL AND status IN ('needs_user','awaiting_approval') AND submit_attempted_at IS NULL RETURNING id", [row.job_id]);
  if (requeued.rowCount) await dispatchWorker();
  return row;
}

// Statuses a worker may be acting on; these jobs must be cancelled before they can be deleted.
export const ACTIVE_STATUSES = ["queued", "running", "needs_user", "awaiting_approval"];

// Deletes one job (id) or every inactive job, with its steps, questions, documents and stored files. The audit log
// and matched inbox mail are kept but unlinked, so the record of what was submitted survives. Returns the count.
// ponytail: files stored in R2 (when configured) are not removed; only the Neon blobs table is cleaned.
export async function deleteJobs(id?: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids: string[] = (await client.query(
      `SELECT id FROM jobs WHERE status <> ALL($1::text[])${id ? " AND id=$2" : ""} FOR UPDATE`,
      id ? [ACTIVE_STATUSES, id] : [ACTIVE_STATUSES],
    )).rows.map(r => r.id);
    if (ids.length) {
      for (const table of ["job_steps", "questions", "documents"]) await client.query(`DELETE FROM ${table} WHERE job_id = ANY($1::uuid[])`, [ids]);
      await client.query("UPDATE audit_log SET job_id=NULL WHERE job_id = ANY($1::uuid[])", [ids]);
      await client.query("UPDATE inbox_messages SET job_id=NULL WHERE job_id = ANY($1::uuid[])", [ids]);
      await client.query("DELETE FROM blobs WHERE key LIKE ANY($1::text[])", [ids.map(j => `jobs/${j}/%`)]);
      await client.query("DELETE FROM jobs WHERE id = ANY($1::uuid[])", [ids]);
    }
    await client.query("COMMIT");
    return ids.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
