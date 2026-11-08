// Applies db/*.sql in order. Usage: DATABASE_URL=... node scripts/migrate.mjs
import { readdir, readFile } from 'node:fs/promises'
import pg from 'pg'

const dir = new URL('../db/', import.meta.url)
const files = (await readdir(dir)).filter(f => /^\d+_.*\.sql$/.test(f)).sort()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
try {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
  for (const file of files) {
    if ((await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file])).rowCount) continue
    await db.query('BEGIN')
    try {
      await db.query(await readFile(new URL(file, dir), 'utf8'))
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      await db.query('COMMIT')
      console.log('applied', file)
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    }
  }
} finally {
  await db.end()
}
