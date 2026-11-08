// Needs DATABASE_URL (migrated) and a Chromium. Skipped otherwise.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { chromium } from 'playwright'
import { createContext, Stop } from './lib/context.mjs'
import { runAgent } from './lib/agent.mjs'
import { setModelBackend } from './lib/gemini.mjs'

const skip = !process.env.DATABASE_URL

const FORM = `<!doctype html><title>Apply</title><form method="post" action="/submit" enctype="application/x-www-form-urlencoded">
<label for=f>First name</label><input id=f name=f>
<label for=e>Email</label><input id=e name=e type=email>
<label for=y>Years of Python</label><input id=y name=y>
<label for=w>Work authorization</label><select id=w name=w><option></option><option>Yes</option><option>No</option></select>
<label for=r>Resume</label><input id=r type=file name=r>
<label for=v>Veteran status</label><input id=v name=v>
<button type="submit">Submit application</button></form>`

let posts = 0
const server = http.createServer((req, res) => {
  if (req.method === 'POST') { posts++; res.setHeader('content-type', 'text/html'); return res.end('<h1>Thank you for applying!</h1>') }
  res.setHeader('content-type', 'text/html'); res.end(FORM)
})

// Stands in for Gemini: a tiny rule-based planner reading the same prompt payload. Page plans come back empty
// so the step planner decides each field, which is what these tests check.
function fakeGemini(prompt, kind) {
  if (kind === 'plan') return { rows: [] }
  if (kind === 'parse_jd') return { title: 'Intern', company: 'Test', must_have: [], keywords: [], seniority: '' }
  const payload = JSON.parse(prompt.slice(0, prompt.indexOf('\n<untrusted_page>')))
  const els = payload.elements
  const by = label => els.find(e => e.label === label)
  if (by('Years of Python') && !by('Years of Python').value) return { action: 'ask_human', ref: by('Years of Python').ref, question: 'Years of Python', source: 'unknown', confidence: 'low' }
  const w = by('Work authorization')
  if (w && !w.value) return { action: 'select', ref: w.ref, value: 'Yes', source: 'inferred', confidence: 'medium', reason: 'applicant lives here' }
  const r = by('Resume')
  if (r && !r.value) return { action: 'upload', ref: r.ref, doc: 'resume', source: 'document', confidence: 'high' }
  const v = by('Veteran status')
  if (v && !v.value) return { action: 'fill', ref: v.ref, value: 'No', source: 'inferred', confidence: 'high' }
  return { action: 'click', ref: els.find(e => e.label === 'Submit application').ref, source: 'inferred', confidence: 'high' }
}

async function setup(mode) {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
  const id = randomUUID()
  await db.query("INSERT INTO jobs (id, application_url, mode, status, claimed_by, lease_until) VALUES ($1,$2,$3,'running','w',now()+interval '1 hour')", [id, 'https://example.com/job', mode])
  const job = (await db.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0]
  const ctx = createContext({ db, job, workerId: 'w', settings: {} })
  ctx.allowedDomains = []
  return { db, ctx, id }
}

const profile = { first_name: 'Asha', last_name: 'Rao', email: 'asha@example.com', sensitive: { veteran: { value: 'No', mode: 'ask' } } }
// Answers the first open question after it appears, like the Telegram webhook would.
async function answerer(db, id, answers) {
  for (const answer of answers) {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500))
      const r = await db.query('UPDATE questions SET answer=$2, answered_at=now() WHERE id=(SELECT id FROM questions WHERE job_id=$1 AND answer IS NULL ORDER BY id LIMIT 1) RETURNING id', [id, answer])
      if (r.rowCount) break
    }
  }
}

async function withPage(fn) {
  await new Promise(r => server.listen(0, r))
  let browser
  setModelBackend(async ({ prompt, kind }) => ({ text: JSON.stringify(fakeGemini(prompt, kind)) }))
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
    const page = await browser.newPage()
    await page.goto(`http://localhost:${server.address().port}/`)
    await fn(page)
  } finally {
    setModelBackend(null)
    await browser?.close(); server.close()
  }
}

test('dry run fills known fields, asks for unknowns, never submits', { skip, timeout: 90000 }, async () => {
  const { db, ctx, id } = await setup('dry_run')
  const file = path.join(os.tmpdir(), 'resume.pdf'); await writeFile(file, '%PDF-1.4')
  await withPage(async page => {
    const [result] = await Promise.all([
      runAgent({ page, ctx, profile, bank: [], upload: async () => file, platform: 'custom', maxSteps: 30 }),
      answerer(db, id, ['3', 'No']),
    ])
    assert.equal(result.status, 'needs_user')
    assert.match(result.note, /Dry run/)
  })
  assert.equal(posts, 0)
  const job = (await db.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0]
  assert.equal(job.submit_attempted_at, null)
  const steps = (await db.query('SELECT kind, detail FROM job_steps WHERE job_id=$1 ORDER BY id', [id])).rows
  assert.ok(steps.some(s => s.kind === 'prefill'))
  assert.ok(steps.some(s => s.kind === 'ask_human'))
  assert.ok(steps.some(s => s.kind === 'dry_run_stop'))
  assert.ok(job.flags.some(f => f.includes('Work authorization')))
  // Sensitive field ("ask" mode) was put to the human, not filled by the model, and the answer is banked.
  const questions = (await db.query('SELECT prompt FROM questions WHERE job_id=$1 ORDER BY id', [id])).rows.map(r => r.prompt)
  assert.deepEqual(questions, ['Years of Python', 'Veteran status'])
  assert.equal((await db.query("SELECT answer FROM answer_bank WHERE normalized='years of python'")).rows[0].answer, '3')
  const shots = (await db.query('SELECT count(*)::int n FROM job_steps WHERE job_id=$1 AND screenshot_key IS NOT NULL', [id])).rows[0].n
  assert.ok(shots >= 3)
  await db.end()
})

test('review mode waits for approval, records the attempt, captures the receipt', { skip, timeout: 90000 }, async () => {
  const { db, ctx, id } = await setup('review')
  ctx.job.application_url = 'https://localhost/job'
  const file = path.join(os.tmpdir(), 'resume.pdf')
  await db.query("INSERT INTO answer_bank (question, normalized, answer) VALUES ('Years of Python','years of python','3') ON CONFLICT (normalized) DO NOTHING")
  await withPage(async page => {
    const [result] = await Promise.all([
      runAgent({ page, ctx, profile, bank: (await db.query('SELECT question, answer FROM answer_bank')).rows, upload: async () => file, platform: 'custom', maxSteps: 30 }),
      answerer(db, id, ['No', 'Approve']),
    ])
    assert.equal(result.status, 'applied')
  })
  assert.equal(posts, 1)
  const job = (await db.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0]
  assert.ok(job.submit_attempted_at)
  assert.match(job.receipt.snippet, /Thank you/)
  assert.ok((await db.query("SELECT 1 FROM audit_log WHERE job_id=$1 AND action='submit_attempt'", [id])).rowCount === 1)
  await db.end()
})

test('rejecting the approval cancels without submitting', { skip, timeout: 90000 }, async () => {
  posts = 0
  const { db, ctx, id } = await setup('review')
  ctx.job.application_url = 'https://localhost/job'
  await withPage(async page => {
    await assert.rejects(Promise.all([
      runAgent({ page, ctx, profile, bank: [{ question: 'Years of Python', answer: '3' }], upload: async () => path.join(os.tmpdir(), 'resume.pdf'), platform: 'custom', maxSteps: 30 }),
      answerer(db, id, ['No', 'Reject']),
    ]), error => error instanceof Stop && error.status === 'cancelled')
  })
  assert.equal(posts, 0)
  assert.equal((await db.query('SELECT submit_attempted_at FROM jobs WHERE id=$1', [id])).rows[0].submit_attempted_at, null)
  await db.end()
})

test('refuses to submit to a domain outside the allowlist', { skip, timeout: 90000 }, async () => {
  posts = 0
  const { db, ctx, id } = await setup('auto')
  await withPage(async page => {
    await assert.rejects(Promise.all([
      runAgent({ page, ctx, profile, bank: [{ question: 'Years of Python', answer: '3' }], upload: async () => path.join(os.tmpdir(), 'resume.pdf'), platform: 'custom', maxSteps: 30 }),
      answerer(db, id, ['No']),
    ]), error => error instanceof Stop && error.status === 'manual' && /allowlist/.test(error.note))
  })
  assert.equal(posts, 0)
  await db.end()
})

import { assembleResume, resumeHtml, coverLetterHtml, htmlToPdf } from './lib/documents.mjs'
test('resume renders to a valid one-page PDF even with lots of content', { skip: skip || !process.env.CHROMIUM_PATH, timeout: 60000 }, async () => {
  const rich = {
    first_name: 'Asha', last_name: 'Rao', email: 'a@example.com', phone: '1', location: 'Bengaluru',
    education: [{ school: 'State University', degree: 'B.Tech CSE', start: '2023', end: 'June 2027' }],
    skills: Array.from({ length: 40 }, (_, i) => ({ name: `Skill${i}` })),
    experiences: Array.from({ length: 4 }, (_, i) => ({ id: `e${i}`, company: `Co${i}`, title: 'Intern', start: '2024', end: '2025', bullets: Array.from({ length: 5 }, (_, j) => `Built feature number ${j} with careful testing and review across the team`) })),
    projects: Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, name: `Proj${i}`, short: 'A project that does a thing well', tech: ['TypeScript'] })),
  }
  const resume = assembleResume(rich, {})
  const pdf = await htmlToPdf(size => resumeHtml(rich, resume, size))
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 1)
  const letter = await htmlToPdf(size => coverLetterHtml(rich, 'Dear team,\n\nHello.', size), { fit: false })
  assert.equal(letter.subarray(0, 5).toString(), '%PDF-')
})
