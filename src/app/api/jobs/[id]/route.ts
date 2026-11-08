import { pool } from "@/lib/db";
import { deny } from "@/lib/guard";
import { answerQuestion, deleteJobs, dispatchWorker } from "@/lib/jobs";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(_: Request, { params }: Ctx) {
  const blocked = await deny(); if (blocked) return blocked;
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "Not found." }, { status: 404 });
  const job = (await pool.query("SELECT * FROM jobs WHERE id=$1", [id])).rows[0];
  if (!job) return Response.json({ error: "Not found." }, { status: 404 });
  const [steps, questions, documents, audit] = await Promise.all([
    pool.query("SELECT id, kind, detail, screenshot_key, created_at FROM job_steps WHERE job_id=$1 ORDER BY id", [id]),
    pool.query("SELECT id, kind, prompt, options, answer, created_at FROM questions WHERE job_id=$1 ORDER BY id", [id]),
    pool.query("SELECT id, kind, blob_key, created_at FROM documents WHERE job_id=$1 ORDER BY id", [id]),
    pool.query("SELECT action, detail, created_at FROM audit_log WHERE job_id=$1 ORDER BY id", [id]),
  ]);
  return Response.json({ job, steps: steps.rows, questions: questions.rows, documents: documents.rows, audit: audit.rows });
}

// actions: approve | reject | cancel | retry | answer
export async function POST(request: Request, { params }: Ctx) {
  const blocked = await deny(); if (blocked) return blocked;
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "Not found." }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  switch (body.action) {
    case "approve": case "reject": {
      const open = (await pool.query("SELECT id FROM questions WHERE job_id=$1 AND kind='approval' AND answer IS NULL ORDER BY id DESC LIMIT 1", [id])).rows[0];
      if (!open || !await answerQuestion(open.id, body.action === "approve" ? "Approve" : "Reject")) return Response.json({ error: "Nothing is waiting for approval." }, { status: 409 });
      return Response.json({ ok: true });
    }
    case "answer": {
      if (typeof body.answer !== "string" || !body.answer.trim() || body.answer.length > 2000) return Response.json({ error: "Answer required." }, { status: 400 });
      const found = (await pool.query("SELECT id FROM questions WHERE job_id=$1 AND answer IS NULL ORDER BY id LIMIT 1", [id])).rows[0];
      if (!found || !await answerQuestion(found.id, body.answer.trim())) return Response.json({ error: "No open question." }, { status: 409 });
      return Response.json({ ok: true });
    }
    case "cancel": {
      const r = await pool.query("UPDATE jobs SET status='cancelled', note='Cancelled from the app', updated_at=now() WHERE id=$1 AND status IN ('queued','running','needs_user','awaiting_approval') AND submit_attempted_at IS NULL RETURNING id", [id]);
      return r.rowCount ? Response.json({ ok: true }) : Response.json({ error: "This job cannot be cancelled." }, { status: 409 });
    }
    case "retry": {
      // Never re-queue anything that may already have been submitted.
      const r = await pool.query("UPDATE jobs SET status='queued', note=NULL, claimed_by=NULL, updated_at=now() WHERE id=$1 AND status IN ('failed','needs_user','manual','cancelled') AND submit_attempted_at IS NULL RETURNING id", [id]);
      if (!r.rowCount) return Response.json({ error: "This job cannot be retried." }, { status: 409 });
      return Response.json({ ok: true, dispatched: await dispatchWorker() });
    }
    case "run": return Response.json({ ok: true, dispatched: await dispatchWorker() });
    default: return Response.json({ error: "Unknown action." }, { status: 400 });
  }
}

// Deletes this job and its steps, questions and files. Active jobs must be cancelled first.
export async function DELETE(_: Request, { params }: Ctx) {
  const blocked = await deny(); if (blocked) return blocked;
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "Not found." }, { status: 404 });
  return await deleteJobs(id) ? Response.json({ deleted: 1 }) : Response.json({ error: "Cancel the job before deleting it." }, { status: 409 });
}
