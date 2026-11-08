import { AwsClient } from "aws4fetch";
import { pool } from "@/lib/db";

function r2() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  return {
    client: new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" }),
    base: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`,
  };
}

export async function getBlob(key: string): Promise<{ data: Uint8Array; contentType: string } | null> {
  const bucket = r2();
  if (bucket) {
    const response = await bucket.client.fetch(`${bucket.base}/${key}`);
    if (!response.ok) return null;
    return { data: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") || "application/octet-stream" };
  }
  const row = (await pool.query("SELECT content_type, data FROM blobs WHERE key=$1", [key])).rows[0];
  return row ? { data: new Uint8Array(row.data), contentType: row.content_type } : null;
}
