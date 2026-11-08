import { deny } from "@/lib/guard";
import { getBlob } from "@/lib/storage";

export async function GET(_: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const blocked = await deny(); if (blocked) return blocked;
  const key = (await params).key.join("/");
  // Only job artifacts are served; browser state and anything else stays private.
  if (!/^jobs\/[0-9a-f-]{36}\/[\w.-]+$/i.test(key)) return Response.json({ error: "Not found." }, { status: 404 });
  const blob = await getBlob(key);
  if (!blob) return Response.json({ error: "Not found." }, { status: 404 });
  return new Response(blob.data as BodyInit, { headers: { "Content-Type": blob.contentType, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}
