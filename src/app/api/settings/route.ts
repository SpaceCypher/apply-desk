import { pool } from "@/lib/db";
import { deny } from "@/lib/guard";
import { MODES } from "@/lib/jobs";

const DOMAIN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;

export async function GET() {
  const blocked = await deny(); if (blocked) return blocked;
  const rows = (await pool.query("SELECT key, value FROM settings")).rows;
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const applied = (await pool.query("SELECT count(*)::int AS n FROM jobs WHERE status='applied'")).rows[0].n;
  // Estimated model spend this month, from each job's recorded token counts (0 before db/003 is applied).
  const spent = (await pool.query("SELECT COALESCE(sum((cost->>'cost')::numeric), 0)::float AS usd FROM jobs WHERE updated_at >= date_trunc('month', now()) AND cost IS NOT NULL")
    .catch(() => ({ rows: [{ usd: 0 }] }))).rows[0].usd as number;
  return Response.json({ settings, applied, spent });
}

export async function PUT(request: Request) {
  const blocked = await deny(); if (blocked) return blocked;
  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (body.default_mode !== undefined) {
    if (!(MODES as readonly string[]).includes(body.default_mode)) return Response.json({ error: "Invalid mode." }, { status: 400 });
    updates.default_mode = body.default_mode;
  }
  if (body.allowed_domains !== undefined) {
    const domains = Array.isArray(body.allowed_domains) ? body.allowed_domains.map((d: unknown) => String(d).trim().toLowerCase()) : [];
    if (domains.length > 100 || domains.some((d: string) => !DOMAIN.test(d))) return Response.json({ error: "Invalid domain list." }, { status: 400 });
    updates.allowed_domains = domains;
  }
  if (body.max_steps !== undefined) {
    const n = Number(body.max_steps);
    if (!Number.isInteger(n) || n < 10 || n > 400) return Response.json({ error: "Max steps must be between 10 and 400." }, { status: 400 });
    updates.max_steps = n;
  }
  const limits = [["max_minutes", 5, 120, "Minutes per job"], ["max_tokens", 20000, 5000000, "Tokens per job"], ["monthly_budget_usd", 0, 1000, "Monthly budget"]] as const;
  for (const [key, min, max, label] of limits) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < min || n > max) return Response.json({ error: `${label} must be between ${min} and ${max}.` }, { status: 400 });
    updates[key] = key === "monthly_budget_usd" ? Math.round(n * 100) / 100 : Math.round(n);
  }
  for (const [key, value] of Object.entries(updates)) {
    await pool.query("INSERT INTO settings (key, value) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [key, JSON.stringify(value)]);
  }
  return Response.json({ saved: true });
}
