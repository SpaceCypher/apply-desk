import { timingSafeEqual } from "node:crypto";
import { pool } from "@/lib/db";
import { deny } from "@/lib/guard";
import { decrypt } from "@/lib/vault";

// Domains only. Secrets are never returned from the list.
export async function GET() {
  const blocked = await deny(); if (blocked) return blocked;
  return Response.json({ credentials: (await pool.query("SELECT id, domain, created_at FROM credentials ORDER BY domain")).rows });
}

const attempts: number[] = [];
function pinOk(pin: unknown) {
  const expected = process.env.VAULT_REVEAL_PIN || "";
  if (expected.length < 6 || typeof pin !== "string" || pin.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(pin), Buffer.from(expected));
}

// Revealing needs the separate reveal PIN on top of the GitHub session, and is rate limited.
export async function POST(request: Request) {
  const blocked = await deny(); if (blocked) return blocked;
  const now = Date.now();
  while (attempts.length && now - attempts[0] > 600000) attempts.shift();
  if (attempts.length >= 5) return Response.json({ error: "Too many attempts. Try later." }, { status: 429 });
  const { id, pin } = await request.json().catch(() => ({}));
  if (!pinOk(pin)) { attempts.push(now); return Response.json({ error: "Wrong PIN." }, { status: 403 }); }
  const row = (await pool.query("SELECT domain, username_enc, password_enc FROM credentials WHERE id=$1", [Number(id) || 0])).rows[0];
  if (!row) return Response.json({ error: "Not found." }, { status: 404 });
  await pool.query("INSERT INTO audit_log (action, detail) VALUES ('vault_reveal', $1)", [JSON.stringify({ domain: row.domain })]);
  return Response.json({ domain: row.domain, username: decrypt(row.username_enc), password: decrypt(row.password_enc) });
}

export async function DELETE(request: Request) {
  const blocked = await deny(); if (blocked) return blocked;
  const { id } = await request.json().catch(() => ({}));
  await pool.query("DELETE FROM credentials WHERE id=$1", [Number(id) || 0]);
  return Response.json({ deleted: true });
}
