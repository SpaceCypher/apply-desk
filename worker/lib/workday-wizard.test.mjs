// Workday-shaped fixtures, not evidence of an authenticated live tenant wizard.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { chromium } from 'playwright'
import { createContext, Stop } from './context.mjs'
import { observe } from './perception/walk.mjs'
import { dispatch, makeSubmit } from './actions/registry.mjs'

const skip = !process.env.DATABASE_URL || !process.env.CHROMIUM_PATH
async function harness(t, mode) {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
  const id = randomUUID()
  await db.query("INSERT INTO jobs(id,application_url,mode,status,claimed_by,lease_until) VALUES($1,'https://example.wd1.myworkdayjobs.com/apply',$2,'running','w',now()+interval '1 hour')", [id, mode])
  const job = (await db.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0]
  const ctx = createContext({ db, job, workerId: 'w', settings: {} })
  ctx.heartbeat = async () => {}; ctx.notify = async () => {}; ctx.asked = []
  ctx.ask = async q => { ctx.asked.push(q.kind); return 'Reject' }
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  const page = await browser.newPage()
  await page.route('https://example.wd1.myworkdayjobs.com/**', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }))
  await page.goto('https://example.wd1.myworkdayjobs.com/apply')
  const env = { page, ctx, mode, platform: 'workday', filled: [], profile: {}, bank: [], shot: null }
  env.submit = makeSubmit(env)
  const act = async (action, label, value) => {
    env.obs = await observe(page)
    const el = env.obs.elements.find(e => e.label === label)
    assert.ok(el, `missing ${label}`)
    return dispatch(env, { action, ref: el.ref, value, source: 'user', confidence: 'high' }, { enforced: true })
  }
  t.after(async () => { await browser.close(); await db.end() })
  return { page, env, ctx, db, id, act }
}

for (const mode of ['dry_run', 'review']) test(`Workday Review: fieldless Submit is gated in ${mode}`, { skip }, async t => {
  const h = await harness(t, mode)
  await h.page.setContent(`<h1>Review</h1><p>My Information · My Experience · Application Questions · Voluntary Disclosures · Self Identify</p>
    <button data-automation-id="bottom-navigation-next-button" onclick="window.sent=true">Submit</button>`)
  if (mode === 'dry_run') assert.equal((await h.act('click', 'Submit')).result, 'dry_run_done')
  else await assert.rejects(h.act('click', 'Submit'), e => e instanceof Stop && e.status === 'cancelled')
  assert.equal(await h.page.evaluate(() => !!window.sent), false)
  assert.deepEqual(h.ctx.asked, mode === 'review' ? ['approval'] : [])
  assert.equal((await h.db.query('SELECT submit_attempted_at FROM jobs WHERE id=$1', [h.id])).rows[0].submit_attempted_at, null)
})

test('Workday experience: split dates fill the requested part, and Add Another exposes another entry', { skip }, async t => {
  const h = await harness(t, 'dry_run')
  await h.page.setContent(`<h1>My Experience</h1><div id="entries"><fieldset><legend>Work Experience 1</legend>
    <label>Job Title<input></label><label>From Month<input role="spinbutton" data-automation-id="dateSectionMonth-input" placeholder="MM"></label>
    <label>From Day<input role="spinbutton" data-automation-id="dateSectionDay-input" placeholder="DD"></label>
    <label>From Year<input role="spinbutton" data-automation-id="dateSectionYear-input" placeholder="YYYY"></label></fieldset></div>
    <button onclick="document.querySelector('#entries').insertAdjacentHTML('beforeend','<fieldset><legend>Education 1</legend><label>School<input></label></fieldset>')">Add Another</button>`)
  assert.equal((await h.act('set_date', 'From Month', '2025-05')).result, 'ok')
  assert.equal((await h.act('set_date', 'From Year', '2025-05')).result, 'ok')
  assert.equal((await h.act('set_date', 'From Day', '2025-05-23')).result, 'ok')
  assert.equal(await h.page.locator('[placeholder=DD]').inputValue(), '23')
  assert.equal(await h.page.locator('[placeholder=MM]').inputValue(), '05')
  assert.equal(await h.page.locator('[placeholder=YYYY]').inputValue(), '2025')
  assert.equal((await h.act('add_entry', 'Add Another')).result, 'ok')
  assert.equal((await h.act('fill', 'School', 'Example Institute')).result, 'ok')
  const obs = await observe(h.page)
  assert.equal(obs.elements.find(e => e.label === 'School').section, 'Education 1')
})

test('Workday wizard: Next advances each page without approval; multi-option questions tick each answer', { skip }, async t => {
  const h = await harness(t, 'review')
  await h.page.setContent(`<h1 id="title">My Information</h1><div id="fields"><input aria-label="City"></div>
    <button data-automation-id="bottom-navigation-next-button" onclick="advance()">Next</button>
    <script>
    const pages = ['My Information', 'My Experience', 'Application Questions', 'Voluntary Disclosures', 'Self Identify', 'Review']; let step=0;
    function advance() { document.querySelector('#title').textContent=pages[++step]; document.querySelector('#fields').innerHTML=''; if(step===5) document.querySelector('button').textContent='Submit' }
    </script>`)
  for (const title of ['My Experience', 'Application Questions', 'Voluntary Disclosures', 'Self Identify', 'Review']) {
    assert.equal((await h.act('click', 'Next')).result, 'ok')
    assert.equal(await h.page.locator('h1').innerText(), title)
  }
  assert.deepEqual(h.ctx.asked, [], 'Next never asks for application approval')
  await h.page.setContent(`<h1>Application Questions</h1><fieldset><legend>Skills</legend>
    <label><input type="checkbox">JavaScript</label><label><input type="checkbox">Python</label></fieldset>`)
  h.ctx.ask = async () => 'JavaScript, Python'
  h.env.obs = await observe(h.page)
  const target = h.env.obs.elements.find(e => e.type === 'checkbox')
  const result = await dispatch(h.env, { action: 'ask_human', ref: target.ref, question: 'Skills' })
  assert.equal(result.result, 'ok:answered')
  assert.equal(await h.page.locator('input:checked').count(), 2)
})
