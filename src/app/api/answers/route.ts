import { pool } from "@/lib/db";
import { deny } from "@/lib/guard";

const normalize = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

export async function GET() {
  const blocked = await deny(); if (blocked) return blocked;
  return Response.json({ answers: (await pool.query("SELECT id, question, answer FROM answer_bank ORDER BY id DESC LIMIT 500")).rows });
}

export async function POST(request: Request) {
  const blocked = await deny(); if (blocked) return blocked;
  const { question, answer } = await request.json().catch(() => ({}));
  if (typeof question !== "string" || typeof answer !== "string" || !question.trim() || !answer.trim()) return Response.json({ error: "Question and answer required." }, { status: 400 });
  await pool.query("INSERT INTO answer_bank (question, normalized, answer) VALUES ($1,$2,$3) ON CONFLICT (normalized) DO UPDATE SET answer=EXCLUDED.answer",
    [question.trim().slice(0, 500), normalize(question).slice(0, 500), answer.trim().slice(0, 2000)]);
  return Response.json({ saved: true }, { status: 201 });
}

export async function DELETE(request: Request) {
  const blocked = await deny(); if (blocked) return blocked;
  const { id } = await request.json().catch(() => ({}));
  await pool.query("DELETE FROM answer_bank WHERE id=$1", [Number(id) || 0]);
  return Response.json({ deleted: true });
}
