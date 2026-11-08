import { pool } from "@/lib/db";
import { deny } from "@/lib/guard";
import { cleanProfile } from "@/lib/profile";

export async function GET() {
  const blocked = await deny(); if (blocked) return blocked;
  const result = await pool.query("SELECT fields FROM profile WHERE id = true");
  return Response.json({ fields: result.rows[0]?.fields || {} });
}

export async function PUT(request: Request) {
  const blocked = await deny(); if (blocked) return blocked;
  let data: Record<string, unknown>;
  try { data = await request.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  const fields = cleanProfile(data);
  await pool.query(
    "INSERT INTO profile (id, fields) VALUES (true, $1::jsonb) ON CONFLICT (id) DO UPDATE SET fields = EXCLUDED.fields, updated_at = now()",
    [JSON.stringify(fields)],
  );
  return Response.json({ saved: true, fields });
}
