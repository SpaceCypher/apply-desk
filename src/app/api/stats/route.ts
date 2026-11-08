import { pool } from "@/lib/db";
import { deny } from "@/lib/guard";

export async function GET() {
  const blocked = await deny(); if (blocked) return blocked;
  return Response.json(await loadStats());
}

export async function loadStats() {
  const [weekly, byStatus, replies] = await Promise.all([
    pool.query("SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week, count(*)::int AS applied FROM jobs WHERE status IN ('applied','submission_unverified') AND created_at > now() - interval '12 weeks' GROUP BY 1 ORDER BY 1"),
    pool.query("SELECT status, count(*)::int AS n FROM jobs GROUP BY status ORDER BY status"),
    pool.query("SELECT count(DISTINCT job_id)::int AS n FROM inbox_messages"),
  ]);
  return { weekly: weekly.rows, byStatus: byStatus.rows, replies: replies.rows[0].n };
}
