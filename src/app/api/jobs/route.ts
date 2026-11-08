import { pool } from "@/lib/db";
import { deny } from "@/lib/guard";
import { createJob, deleteJobs, parseJobUrl } from "@/lib/jobs";

export async function GET() {
  const blocked = await deny(); if (blocked) return blocked;
  const result = await pool.query(
    "SELECT id, application_url, mode, status, title, company, platform, note, created_at, updated_at FROM jobs ORDER BY created_at DESC LIMIT 200",
  );
  return Response.json({ jobs: result.rows });
}

export async function POST(request: Request) {
  const blocked = await deny(); if (blocked) return blocked;
  let body: { url?: unknown; mode?: unknown } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const url = parseJobUrl(body.url);
  if (!url) return Response.json({ error: "Enter a valid HTTPS job link." }, { status: 400 });
  try {
    return Response.json(await createJob(url, typeof body.mode === "string" ? body.mode : undefined), { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not queue job." }, { status: 409 });
  }
}

// Deletes every job that is not active. The body must say {"confirm":"all"} so a stray request cannot wipe the list.
export async function DELETE(request: Request) {
  const blocked = await deny(); if (blocked) return blocked;
  const body = await request.json().catch(() => ({}));
  if (body?.confirm !== "all") return Response.json({ error: "Confirmation required." }, { status: 400 });
  return Response.json({ deleted: await deleteJobs() });
}
