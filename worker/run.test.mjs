// Queue: two workers never claim the same job, and drain() runs every queued job then stops.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { createWorkerDb, drain } from './run.mjs'

const skip = !process.env.DATABASE_URL

test('worker replaces a disconnected idle connection during a job', { skip, timeout: 10000 }, async () => {
  const errors = []
  const db = createWorkerDb(process.env.DATABASE_URL, message => errors.push(message))
  const control = new pg.Client({ connectionString: process.env.DATABASE_URL }); await control.connect()
  try {
    await control.query("UPDATE jobs SET status='cancelled' WHERE status IN ('queued','running')")
    const id = randomUUID()
    await control.query("INSERT INTO jobs (id, application_url, mode) VALUES ($1, 'https://example.com/j', 'dry_run')", [id])
    const results = await drain({ db, log: () => {}, run: async ({ job, workerId }) => {
      const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const disconnected = new Promise(resolve => db.once('error', resolve))
      await control.query('SELECT pg_terminate_backend($1)', [pid])
      await disconnected
      const nextPid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      assert.notEqual(nextPid, pid)
      await db.query("UPDATE jobs SET status='needs_user' WHERE id=$1 AND claimed_by=$2", [job.id, workerId])
      return { status: 'needs_user' }
    } })
    assert.deepEqual(results, [{ id, status: 'needs_user' }])
    assert.equal(errors.length, 1)
    assert.match(errors[0], /Idle worker database connection lost/)
  } finally { await db.end(); await control.end() }
})

test('worker does not replay or hide a query interrupted by a disconnect', { skip, timeout: 10000 }, async () => {
  const db = createWorkerDb(process.env.DATABASE_URL)
  const control = new pg.Client({ connectionString: process.env.DATABASE_URL }); await control.connect()
  try {
    const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const rejected = assert.rejects(db.query('SELECT pg_sleep(30)'), /terminat|connection/i)
    await control.query('SELECT pg_terminate_backend($1)', [pid])
    await rejected
    assert.equal((await db.query('SELECT 1 AS n')).rows[0].n, 1)
  } finally { await db.end(); await control.end() }
})

test('concurrent claims get distinct jobs; drain empties the queue and stops', { skip, timeout: 30000 }, async () => {
  const a = new pg.Client({ connectionString: process.env.DATABASE_URL }); await a.connect()
  const b = new pg.Client({ connectionString: process.env.DATABASE_URL }); await b.connect()
  try {
    await a.query("UPDATE jobs SET status='cancelled' WHERE status IN ('queued','running')")
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    for (const id of ids) await a.query("INSERT INTO jobs (id, application_url, mode) VALUES ($1, 'https://example.com/j', 'dry_run')", [id])
    const claim = await readFile(new URL('../db/claim_job.sql', import.meta.url), 'utf8')
    await a.query('BEGIN'); await b.query('BEGIN')
    const [ra, rb] = await Promise.all([a.query(claim, ['wa', '15 minutes']), b.query(claim, ['wb', '15 minutes'])])
    await a.query('COMMIT'); await b.query('COMMIT')
    assert.equal(ra.rowCount, 1); assert.equal(rb.rowCount, 1)
    assert.notEqual(ra.rows[0].id, rb.rows[0].id)

    // drain() picks up what is left (the third job), plus the two leases above once they expire.
    await a.query("UPDATE jobs SET lease_until = now() - interval '1 minute' WHERE id = ANY($1)", [[ra.rows[0].id, rb.rows[0].id]])
    const ran = []
    const results = await drain({ db: a, log: () => {}, run: async ({ job, workerId }) => {
      ran.push(job.id)
      await a.query("UPDATE jobs SET status='needs_user' WHERE id=$1 AND claimed_by=$2", [job.id, workerId])
      return { status: 'needs_user' }
    } })
    assert.deepEqual(new Set(ran), new Set(ids))
    assert.equal(results.length, 3)
    assert.deepEqual(await drain({ db: a, log: () => {}, run: async () => { throw new Error('should not run') } }), [])
  } finally { await a.end(); await b.end() }
})

import { monthSpend, withinMonthlyBudget } from './run.mjs'
test('monthly budget: alert once at 80%, stop claiming at 100%', { skip, timeout: 30000 }, async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
  try {
    await db.query("INSERT INTO jobs (id, application_url, status, cost) VALUES ($1, 'https://example.com/j', 'applied', '{\"cost\": 5}')", [randomUUID()])
    const spent = await monthSpend(db)
    assert.ok(spent >= 5)
    const sent = []
    const send = async m => { sent.push(m) }
    assert.equal(await withinMonthlyBudget(db, { monthly_budget_usd: spent * 1.1 }, () => {}, send), true)
    assert.match(sent[0], /Heads up/)
    const settings = Object.fromEntries((await db.query('SELECT key, value FROM settings')).rows.map(r => [r.key, r.value]))
    assert.equal(await withinMonthlyBudget(db, { ...settings, monthly_budget_usd: spent * 1.1 }, () => {}, send), true)
    assert.equal(sent.length, 1, 'the 80% alert is sent once per month')
    assert.equal(await withinMonthlyBudget(db, { monthly_budget_usd: spent * 0.9 }, () => {}, send), false)
    assert.match(sent[1], /budget reached/)
    assert.equal(await withinMonthlyBudget(db, { monthly_budget_usd: 0 }, () => {}, send), true, '0 means no cap')
  } finally { await db.end() }
})
