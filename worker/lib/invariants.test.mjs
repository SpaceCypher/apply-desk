// Safety invariants: every way of acting on the page must hit the submit gate (or the tripwire) before an
// application can be sent. These tests deliberately run WITHOUT the dry-run network block or the submit-event
// guard that session.mjs installs, so the gate alone has to stop the POST.
// Needs DATABASE_URL (migrated) and a Chromium (CHROMIUM_PATH). Skipped otherwise.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { chromium } from 'playwright'
import { createContext, Stop } from './context.mjs'
import { observe } from './perception/walk.mjs'
import { dispatch, makeSubmit } from './actions/registry.mjs'

const skip = !process.env.DATABASE_URL || !process.env.CHROMIUM_PATH

const FORM = `<!doctype html><body><form action="/submit" method="post">
<label for="n">Full name</label><input id="n" name="n" value="Aarav Mehta">
<label for="e">Email</label><input id="e" name="e" type="email" value="a@example.com">
<label for="c">Country</label><select id="c" name="c"><option>India</option><option>Germany</option></select>
<button type="submit" id="go" style="position:absolute;left:40px;top:300px;width:220px;height:40px">Submit application</button>
</form>
<button type="button" id="fake" style="position:absolute;left:40px;top:380px" onclick="document.body.innerHTML='<h1>Thank you for applying!</h1>'">Continue</button>
</body>`

let posts = 0
const server = http.createServer((req, res) => {
  if (req.method === 'POST') { posts++; res.end('<h1>Thank you for applying!</h1>'); return }
  res.setHeader('content-type', 'text/html'); res.end(FORM)
})

async function harness(mode, t) {
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
  const id = randomUUID()
  await db.query("INSERT INTO jobs (id, application_url, mode, status, claimed_by, lease_until) VALUES ($1,$2,$3,'running','w',now()+interval '1 hour')", [id, `http://127.0.0.1:${server.address().port}/`, mode])
  const job = (await db.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0]
  const ctx = createContext({ db, job, workerId: 'w', settings: {} })
  ctx.allowedDomains = []
  ctx.notify = async () => {}
  ctx.heartbeat = async () => {}
  ctx.asked = []
  ctx.ask = async q => { ctx.asked.push(q.kind); return q.kind === 'approval' ? 'Reject' : 'skip' }
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const env = { page, ctx, profile: { first_name: 'Aarav', email: 'a@example.com' }, bank: [], upload: async () => '/dev/null', mode, filled: [], platform: 'custom', shot: null }
  env.submit = makeSubmit(env)
  env.obs = await observe(page)
  const ref = label => env.obs.elements.find(e => e.label === label)?.ref
  t.after(async () => { await browser.close(); await db.end(); await new Promise(r => server.close(r)) })
  posts = 0
  return { env, ref, db, id, page }
}

// Each entry: how to try to submit. All must hit the gate.
const ATTEMPTS = {
  click: (env, ref) => ({ action: 'click', ref: ref('Submit application') }),
  click_at: () => ({ action: 'click_at', x: 150, y: 320 }),
  enter_in_text_field: async (env, ref, page) => { await page.focus('#n'); return { action: 'press_key', key: 'Enter' } },
  space_on_focused_button: async (env, ref, page) => { await page.focus('#go'); return { action: 'press_key', key: 'Space' } },
  enter_on_focused_button: async (env, ref, page) => { await page.focus('#go'); return { action: 'press_key', key: 'Enter' } },
  batch: (env, ref) => ({ action: 'batch', actions: [{ action: 'fill', ref: ref('Full name'), value: 'Aarav Mehta', source: 'profile', confidence: 'high' }, { action: 'click', ref: ref('Submit application') }] }),
  check_on_button: (env, ref) => ({ action: 'check', ref: ref('Submit application'), source: 'profile', confidence: 'high' }),
}

for (const [name, make] of Object.entries(ATTEMPTS)) {
  test(`dry run: ${name} stops at the gate and sends nothing`, { skip, timeout: 60000 }, async t => {
    const { env, ref, page, db, id } = await harness('dry_run', t)
    const r = await dispatch(env, await make(env, ref, page))
    assert.equal(r.result, 'dry_run_done', `result was ${r.result}`)
    await page.waitForTimeout(500)
    assert.equal(posts, 0)
    assert.equal((await db.query('SELECT submit_attempted_at FROM jobs WHERE id=$1', [id])).rows[0].submit_attempted_at, null)
  })
  test(`review: ${name} asks for approval; a rejection sends nothing`, { skip, timeout: 60000 }, async t => {
    const { env, ref, page, db, id } = await harness('review', t)
    await assert.rejects(dispatch(env, await make(env, ref, page)), e => e instanceof Stop && e.status === 'cancelled')
    assert.deepEqual(env.ctx.asked, ['approval'])
    await page.waitForTimeout(500)
    assert.equal(posts, 0)
    assert.equal((await db.query('SELECT submit_attempted_at FROM jobs WHERE id=$1', [id])).rows[0].submit_attempted_at, null)
  })
}

test('non-commit actions on the same form never submit', { skip, timeout: 60000 }, async t => {
  const { env, ref, page } = await harness('review', t)
  for (const a of [
    { action: 'fill', ref: ref('Full name'), value: 'A Mehta', source: 'profile', confidence: 'high' },
    { action: 'select', ref: ref('Country'), value: 'Germany', source: 'profile', confidence: 'high' },
    { action: 'press_key', key: 'Tab' },
    { action: 'scroll' },
  ]) {
    const r = await dispatch(env, a)
    assert.ok(!['dry_run_done'].includes(r.result), `${a.action} -> ${r.result}`)
  }
  await page.waitForTimeout(500)
  assert.equal(posts, 0)
  assert.deepEqual(env.ctx.asked, [])
})

test('tripwire: a confirmation page after a non-submit action is recorded and never retried', { skip, timeout: 60000 }, async t => {
  const { env, ref, db, id } = await harness('review', t)
  await assert.rejects(dispatch(env, { action: 'click', ref: ref('Continue') }), e => e instanceof Stop && e.status === 'submission_unverified')
  const job = (await db.query('SELECT submit_attempted_at FROM jobs WHERE id=$1', [id])).rows[0]
  assert.ok(job.submit_attempted_at, 'the attempt is recorded so the job is never resubmitted')
  assert.equal(env.ctx.stats.safety_violations, 1)
  assert.equal((await db.query("SELECT count(*)::int n FROM audit_log WHERE job_id=$1 AND action='tripwire'", [id])).rows[0].n, 1)
})

test('stale refs are refused, not executed blind', { skip, timeout: 60000 }, async t => {
  const { env, ref, page } = await harness('review', t)
  const go = ref('Submit application')
  await page.evaluate(() => { const b = document.getElementById('go'); b.textContent = 'Withdraw application' })
  const r = await dispatch(env, { action: 'click', ref: go })
  assert.equal(r.result, 'stale')
  assert.equal(posts, 0)
})

// Account forms are not the application: their "Submit"/"Sign up"/"Confirm" must not take the submit lock (that
// marked the job submission_unverified forever). Anything that looks like an application still gates.
test('account and code pages are not the application submit; application forms still gate', async () => {
  const { isSubmitControl, accountPage } = await import('./perception/walk.mjs')
  const f = (label, type = 'text', extra = {}) => ({ tag: 'input', type, role: 'textbox', label, ...extra })
  const b = label => ({ tag: 'button', type: 'submit', role: 'button', label })
  const signUp = [f('Email', 'email'), f('Password', 'password'), f('Verify password', 'password')]
  for (const label of ['Sign up', 'Send code', 'Submit', 'Get started', 'Join', 'Create Account'])
    assert.equal(isSubmitControl(b(label), [...signUp, b(label)]), false, `sign-up page: ${label}`)
  for (const label of ['Submit', 'Confirm']) assert.equal(isSubmitControl(b(label), [f('Verification code'), b(label)]), false, `code page: ${label}`)
  assert.equal(accountPage([f('Email', 'email'), f('Password', 'password')]), 'sign_in')
  assert.equal(accountPage([f('New password', 'password'), f('Confirm new password', 'password')]), 'reset')
  // Still the application: a resume field, many fields, the page saying so, or the button saying so.
  assert.equal(isSubmitControl(b('Submit'), [f('First name'), f('Email', 'email'), f('Password', 'password'), f('Resume', 'file', { file: true }), b('Submit')]), true)
  assert.equal(isSubmitControl(b('Submit'), [...signUp, b('Submit')], { text: 'Create a password to submit your application.' }), true)
  assert.equal(isSubmitControl(b('Submit application'), [...signUp, b('Submit application')]), true)
  const many = ['First name', 'Last name', 'Phone', 'City', 'LinkedIn', 'Website'].map(l => f(l))
  assert.equal(isSubmitControl(b('Submit'), [...many, f('Password', 'password'), b('Submit')]), true)
  assert.equal(isSubmitControl(b('Submit'), [f('Full name'), f('Email', 'email'), b('Submit')]), true, 'no password or code field: an application')
})
