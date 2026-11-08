import { AwsClient } from 'aws4fetch'

// Cloudflare R2 when configured, otherwise the `blobs` table in Neon.
// BENCH_LOCAL_BLOBS=1 keeps bench screenshots in the bench database; { remote: true } still uses R2 when set.
function r2({ remote = false } = {}) {
  if (process.env.BENCH_LOCAL_BLOBS === '1' && !remote) return null
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null
  return {
    client: new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' }),
    base: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`,
  }
}

export async function putBlob(db, key, data, contentType, opts = {}) {
  const bucket = r2(opts)
  if (bucket) {
    const response = await bucket.client.fetch(`${bucket.base}/${key}`, { method: 'PUT', body: data, headers: { 'Content-Type': contentType } })
    if (!response.ok) throw new Error(`R2 upload failed with ${response.status}`)
    return key
  }
  await db.query('INSERT INTO blobs (key, content_type, data) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data', [key, contentType, data])
  return key
}

export async function getBlob(db, key) {
  const bucket = r2()
  if (bucket) {
    const response = await bucket.client.fetch(`${bucket.base}/${key}`)
    if (!response.ok) return null
    return { data: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'application/octet-stream' }
  }
  const row = (await db.query('SELECT content_type, data FROM blobs WHERE key=$1', [key])).rows[0]
  return row ? { data: row.data, contentType: row.content_type } : null
}
