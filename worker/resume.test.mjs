// Park and resume through the real runJob: an unanswered question parks the job (no runner held), the answer
// re-queues it, the resumed run uses the answer; the approval parks too, and Approve resumes and submits once.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { runJob } from './lib/session.mjs'
import { createPolicy } from './lib/security.mjs'
import { setModelBackend } from './lib/gemini.mjs'

const skip = !process.env.DATABASE_URL || !process.env.CHROMIUM_PATH
// A question label no earlier test has answered (the answer bank is shared).
const Q = `Years of Zig ${Date.now().toString(36)}`
const FORM = `<!doctype html><title>Apply</title><form method="post" action="/submit">
<label for="f">First name</label><input id="f" name="f">
<label for="e">Email</label><input id="e" name="e" type="email">
<label for="y">${Q}</label><input id="y" name="y">
<button type="submit">Submit application</button></form>`

test('a question parks the job, the answer resumes it, approval parks, Approve submits once', { skip, timeout: 180000 }, async () => {
  let posts = 0
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.method === 'POST') { posts++; return res.end('<h1>Thank you for applying!</h1>') }
    res.end(FORM)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
  const env = { ASK_WAIT_SECONDS: process.env.ASK_WAIT_SECONDS, HEADLESS: process.env.HEADLESS }
  process.env.ASK_WAIT_SECONDS = '6'; process.env.HEADLESS = '1'
  setModelBackend(async ({ kind, prompt }) => {
    if (kind === 'parse_jd') return { text: '{"title":"Intern","company":"Test","must_have":[],"keywords":[],"seniority":""}' }
    if (kind === 'plan' || kind === 'reflect') return { text: kind === 'plan' ? '{"rows":[]}' : '{"lessons":[]}' }
    const p = JSON.parse(prompt.slice(0, prompt.indexOf('\n<untrusted_page>')))
    const y = p.elements.find(e => e.label === Q)
    if (y && !y.value) return { text: JSON.stringify({ action: 'ask_human', ref: y.ref, question: Q, source: 'unknown', confidence: 'low' }) }
    return { text: JSON.stringify({ action: 'click', ref: p.elements.find(e => e.label === 'Submit application').ref, reason: 'submit' }) }
  })
  const id = randomUUID()
  try {
    await db.query("INSERT INTO profile (id, fields) VALUES (true, $1) ON CONFLICT (id) DO UPDATE SET fields=EXCLUDED.fields", [JSON.stringify({ first_name: 'Aarav', last_name: 'Mehta', email: 'a@example.com' })])
    await db.query("UPDATE settings SET value='false' WHERE key='kill_switch'")
    await db.query("UPDATE jobs SET status='cancelled' WHERE status IN ('queued','running')")
    await db.query("INSERT INTO jobs (id, application_url, mode) VALUES ($1, $2, 'review')", [id, `http://127.0.0.1:${server.address().port}/`])
    const claim = await readFile(new URL('../db/claim_job.sql', import.meta.url), 'utf8')
    const settings = { max_steps: 30, kill_switch: false, allowed_domains: [] }
    const run = async () => {
      const job = (await db.query(claim, ['w-' + randomUUID(), '15 minutes'])).rows[0]
      assert.equal(job?.id, id, 'the job is claimable')
      return runJob({ db, job, workerId: job.claimed_by, settings, policy: createPolicy({ allowLoopback: true }), resume: job.checkpoint })
    }
    // What answerQuestion() in src/lib/jobs.ts does when you reply.
    const answer = async (kind, text) => {
      const q = (await db.query('SELECT id FROM questions WHERE job_id=$1 AND kind=$2 AND answer IS NULL ORDER BY id DESC LIMIT 1', [id, kind])).rows[0]
      await db.query('UPDATE questions SET answer=$2, answered_at=now() WHERE id=$1', [q.id, text])
      await db.query("UPDATE jobs SET status='queued' WHERE id=$1 AND checkpoint IS NOT NULL AND claimed_by IS NULL AND status IN ('needs_user','awaiting_approval')", [id])
    }
    const job = async () => (await db.query('SELECT status, checkpoint, claimed_by, submit_attempted_at FROM jobs WHERE id=$1', [id])).rows[0]

    const r1 = await run()
    assert.equal(r1.parked, true)
    let j = await job()
    assert.equal(j.status, 'needs_user'); assert.equal(j.claimed_by, null); assert.ok(j.checkpoint?.url)

    await answer('question', '3')
    const r2 = await run()
    assert.equal(r2.parked, true, 'parks again at the approval')
    j = await job()
    assert.equal(j.status, 'awaiting_approval'); assert.equal(j.submit_attempted_at, null); assert.equal(posts, 0)
    assert.equal((await db.query('SELECT answer FROM answer_bank WHERE question=$1', [Q])).rows[0]?.answer, '3')

    await answer('approval', 'Approve')
    const r3 = await run()
    assert.equal(r3.status, 'applied')
    assert.equal(posts, 1, 'submitted exactly once')
    j = await job()
    assert.ok(j.submit_attempted_at); assert.equal(j.checkpoint, null)
  } finally {
    setModelBackend(null)
    Object.assign(process.env, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)))
    if (env.ASK_WAIT_SECONDS === undefined) delete process.env.ASK_WAIT_SECONDS
    if (env.HEADLESS === undefined) delete process.env.HEADLESS
    await db.end(); server.close()
  }
})
