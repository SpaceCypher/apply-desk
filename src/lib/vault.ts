import { createDecipheriv } from "node:crypto";

// Same AES-256-GCM format as worker/lib/vault.mjs: iv.tag.ciphertext (base64url).
export function decrypt(token: string): string {
  const key = Buffer.from(process.env.VAULT_KEY || "", "base64");
  if (key.length !== 32) throw new Error("VAULT_KEY must be 32 bytes, base64 encoded");
  const [iv, tag, data] = token.split(".").map(p => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
