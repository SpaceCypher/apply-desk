import { pool } from "@/lib/db";
import { deny } from "@/lib/guard";

export async function GET() {
  const blocked = await deny(); if (blocked) return blocked;
  const rows = (await pool.query("SELECT d.id, d.kind, d.blob_key, d.created_at, d.job_id, j.title, j.company FROM documents d LEFT JOIN jobs j ON j.id=d.job_id ORDER BY d.id DESC LIMIT 200")).rows;
  return Response.json({ documents: rows });
}
