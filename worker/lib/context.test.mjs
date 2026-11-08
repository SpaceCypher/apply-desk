// Needs DATABASE_URL (migrated). Skipped otherwise.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createContext } from './context.mjs'

const skip = !process.env.DATABASE_URL

test('an approval given on a parked run is reused on resume when only the flags in its wording changed', { skip }, async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const id = randomUUID(), worker = randomUUID()
    await db.query("INSERT INTO jobs (id, application_url, mode, status, claimed_by) VALUES ($1, 'https://x.test/a', 'review', 'running', $2)", [id, worker])
    // What you approved on the first run: same fields (hash), different flags in the text.
    await db.query("INSERT INTO questions (job_id, kind, prompt, options, context, answer, answered_at) VALUES ($1, 'approval', $2, '[]', $3, 'Approve', now())",
      [id, 'Ready to submit.\n• Degree: Bachelor\nFlags:\nInferred: Degree', JSON.stringify({ hash: 'h1' })])
    const ctx = createContext({ db, job: { id, application_url: 'https://x.test/a', mode: 'review' }, workerId: worker, settings: {} })
    const ask = hash => ctx.ask({ kind: 'approval', prompt: 'Ready to submit.\n• Degree: Bachelor\nFlags:\nInferred: Degree\nInferred: Degree', options: ['Approve', 'Reject'], remember: false, context: { hash }, timeoutMs: 1 })
    assert.equal(await ask('h1'), 'Approve', 'same content: no second approval')
    await assert.rejects(ask('h1'), 'an approval is consumed once')
    await assert.rejects(ask('h2'), 'different content still needs a new approval')
  } finally {
    await db.end()
  }
})
