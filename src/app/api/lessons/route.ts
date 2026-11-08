import { pool } from "@/lib/db";
import { deny } from "@/lib/guard";
import { validateLesson } from "@/lib/lessons";

const normalize = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

export async function GET() {
  const blocked = await deny(); if (blocked) return blocked;
  try {
    const { rows } = await pool.query("SELECT id, scope, text, status, source, success_count, failure_count, evidence, created_at, last_used FROM lessons ORDER BY status = 'retired', status DESC, last_used DESC NULLS LAST, id DESC LIMIT 300");
    return Response.json({ lessons: rows });
  } catch {
    return Response.json({ lessons: null, error: "Run npm run migrate to add the lessons table." });
  }
}

// Add your own lesson (same validation as learned ones).
export async function POST(request: Request) {
  const blocked = await deny(); if (blocked) return blocked;
  const { scope, text } = await request.json().catch(() => ({}));
  if (typeof scope !== "string" || !/^(platform|domain):[a-z0-9._-]{2,80}$/i.test(scope)) return Response.json({ error: "Scope must look like platform:workday or domain:acme.wd5.myworkdayjobs.com." }, { status: 400 });
  const problem = typeof text === "string" ? validateLesson(text) : "text is required";
  if (problem) return Response.json({ error: `Not saved: ${problem}.` }, { status: 400 });
  await pool.query("INSERT INTO lessons (scope, text, normalized, source, status) VALUES ($1,$2,$3,'manual','trusted') ON CONFLICT (scope, normalized) DO UPDATE SET status='trusted'",
    [scope.toLowerCase(), text.trim(), normalize(text)]);
  return Response.json({ saved: true }, { status: 201 });
}

// Trust or retire a lesson.
export async function PATCH(request: Request) {
  const blocked = await deny(); if (blocked) return blocked;
  const { id, status } = await request.json().catch(() => ({}));
  if (!["trusted", "retired", "candidate"].includes(status)) return Response.json({ error: "Invalid status." }, { status: 400 });
  await pool.query("UPDATE lessons SET status=$2 WHERE id=$1", [Number(id) || 0, status]);
  return Response.json({ saved: true });
}

export async function DELETE(request: Request) {
  const blocked = await deny(); if (blocked) return blocked;
  const { id } = await request.json().catch(() => ({}));
  await pool.query("DELETE FROM lessons WHERE id=$1", [Number(id) || 0]);
  return Response.json({ deleted: true });
}
