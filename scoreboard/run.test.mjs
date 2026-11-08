// The scoreboard end to end on a local form: the current engine (real runJob, scripted model) fills it in dry run,
// the runner scores the page against a key, writes a scoreboard_runs row, and nothing reaches the form's server.
// Needs DATABASE_URL (migrated) and a Chromium (CHROMIUM_PATH). Skipped otherwise.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { writeFile, readFile } from 'node:fs/promises'
import pg from 'pg'
import { createPolicy } from '../worker/lib/security.mjs'
import { setModelBackend } from '../worker/lib/gemini.mjs'
import { scriptedPlanner } from '../bench/scripted.mjs'
import { runScoreboard, report, literalOf, answerer } from './run.mjs'

const skip = !process.env.DATABASE_URL || !process.env.CHROMIUM_PATH

const FORM = `<!doctype html><title>Apply</title><body><h1>Apply: Software Engineer Intern</h1>
<form action="/submit" method="post" enctype="multipart/form-data">
<label for="fn">First name *</label><input id="fn" name="fn" required>
<label for="ln">Last name *</label><input id="ln" name="ln" required>
<label for="em">Email *</label><input id="em" name="em" type="email" required>
<label for="deg">Degree *</label><select id="deg" name="deg" required><option value="">Select...</option><option>Bachelor of Technology</option><option>Master of Science</option></select>
<fieldset><legend>Are you authorized to work in India?</legend><label><input type="radio" name="auth" value="y" required> Yes</label><label><input type="radio" name="auth" value="n"> No</label></fieldset>
<label for="cv">Resume *</label><input id="cv" name="cv" type="file" required>
<button type="submit">Submit application</button></form></body>`

test('scoreboard: the current engine fills a form in dry run, is scored against its key, and sends nothing', { skip, timeout: 180000 }, async () => {
  let posts = 0
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') { posts++; res.end('<h1>Thank you for applying!</h1>'); return }
    res.setHeader('content-type', 'text/html'); res.end(FORM)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/apply`
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
  const persona = JSON.parse(await readFile(new URL('../bench/persona.json', import.meta.url), 'utf8'))
  const bank = [{ question: 'Degree', answer: 'Bachelor of Technology' }, { question: 'Are you authorized to work in India?', answer: 'Yes' }]
  setModelBackend(scriptedPlanner({ profile: persona, answers: bank }))
  const resumePdf = path.join(os.tmpdir(), `scoreboard-test-${process.pid}.pdf`)
  await writeFile(resumePdf, '%PDF-1.4\n%%EOF\n')
  try {
    await db.query("INSERT INTO profile (id, fields) VALUES (true, $1) ON CONFLICT (id) DO UPDATE SET fields=EXCLUDED.fields", [JSON.stringify(persona)])
    await db.query('DELETE FROM answer_bank WHERE question = ANY($1)', [bank.map(b => b.question)])
    for (const b of bank) await db.query('INSERT INTO answer_bank (question, normalized, answer) VALUES ($1,$2,$3) ON CONFLICT (normalized) DO UPDATE SET answer=EXCLUDED.answer', [b.question, b.question.toLowerCase(), b.answer])
    await db.query("UPDATE scoreboard_postings SET active=false")
    const key = { entries: [
      { label: 'First name *', kind: 'text', required: true, expected: persona.first_name },
      { label: 'Last name *', kind: 'text', required: true, expected: 'Sharma' },
      { label: 'Email *', kind: 'text', required: true, expected: persona.email },
      { label: 'Degree *', kind: 'choice', required: true, expected: { regex: '^bachelor' } },
      { label: 'Are you authorized to work in India?', kind: 'radio', required: true, expected: 'Yes' },
      { label: 'Resume *', kind: 'file', required: true, expected: 'resume' },
    ] }
    const id = (await db.query("INSERT INTO scoreboard_postings (platform, url, title, key) VALUES ('fixture', $1, 'Local fixture', $2) ON CONFLICT (url) DO UPDATE SET key=EXCLUDED.key, active=true, spare=false RETURNING id", [url, JSON.stringify(key)])).rows[0].id

    const rows = await runScoreboard({ source: db, scratch: db, engine: 'agent', only: { id }, runs: 1, policy: createPolicy({ allowLoopback: true }), resumePdf, runId: `test-${Date.now()}`, log: () => {} })
    assert.equal(rows.length, 1)
    const r = rows[0]
    assert.equal(r.reached_submit, true, `stage ${r.stage}: ${r.note}`)
    assert.equal(r.fields_total, 6)
    assert.equal(r.fields_correct, 5, JSON.stringify(r.wrongList))
    assert.deepEqual(r.wrongList.map(w => [w.label, w.got]), [['Last name *', persona.last_name]], 'the one wrong field is reported with what the page showed')
    assert.equal(r.resume_ok, true)
    assert.equal(posts, 0, 'nothing reached the form server')
    assert.ok(!JSON.parse(r.writes).some(w => w.allowed && /127\.0\.0\.1/.test(w.url)), 'no write to the posting host was allowed')
    const stored = (await db.query('SELECT fields_correct, fields_total, engine FROM scoreboard_runs WHERE run_id=$1', [r.run_id])).rows
    assert.deepEqual(stored, [{ fields_correct: 5, fields_total: 6, engine: 'agent' }])
    const md = report(rows, 'agent')
    assert.match(md, /\| #\d+ fixture Local fixture \| 1 \| yes \| 5\/6 \| yes \|/)
    assert.match(md, /fixture \| 1 \| 0\/1 \| not yet \(1 of 3 postings scored\)/)
  } finally {
    setModelBackend(null)
    await db.query("DELETE FROM scoreboard_postings WHERE platform='fixture'").catch(() => {})
    await db.end(); await new Promise(r => server.close(r))
  }
})

test('stand-in answers come from the key, then the answer bank', async () => {
  assert.equal(literalOf({ regex: '^state' }), 'state')
  assert.equal(literalOf({ regex: '^(bengaluru|bangalore)' }), 'bengaluru')
  assert.equal(literalOf({ regex: '.' }), null)
  assert.equal(literalOf(['Python', 'Go']), 'Python, Go')
  const ask = answerer({ entries: [{ label: 'Notice Period*', expected: 'Immediate' }, { label: 'Gender', skip: true, expected: null }] }, [{ question: 'Current CTC', answer: '0' }])
  assert.equal(await ask({ prompt: 'Notice Period' }), 'Immediate')
  assert.equal(await ask({ prompt: 'Current CTC' }), '0')
  assert.equal(await ask({ prompt: 'Gender', options: ['Male', 'Female', 'Prefer not to say'] }), 'Prefer not to say')
  assert.equal(await ask({ kind: 'approval', prompt: 'Ready to submit' }), 'Reject')
})

test('the scorer reads a form embedded in an iframe (Example Corp-style)', { skip: !process.env.CHROMIUM_PATH, timeout: 60000 }, async () => {
  const { chromium } = await import('playwright')
  const { observeForm } = await import('./run.mjs')
  const { scorePage } = await import('./lib.mjs')
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url.startsWith('/inner')) return res.end('<label for="fn">First Name*</label><input id="fn" value="Aarav"><label for="cv">Resume/CV</label><input id="cv" type="file">')
    res.end('<h1>Careers</h1><iframe src="/inner" width="800" height="400"></iframe>')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/apply`
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  try {
    const page = await browser.newPage()
    await page.goto(url); await page.waitForTimeout(500)
    const obs = await observeForm(page, url)
    const r = scorePage(obs, { entries: [{ label: 'First Name*', kind: 'text', required: true, expected: 'Aarav' }] })
    assert.deepEqual([r.correct, r.total], [1, 1], JSON.stringify(r.wrong))
  } finally {
    await browser.close(); await new Promise(r => server.close(r))
  }
})
