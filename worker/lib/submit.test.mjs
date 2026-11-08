import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { looksConfirmed } from './perception/walk.mjs'
import { clickEl, makeSubmit } from './actions/registry.mjs'

// Workday wiring: the Submit button sits under a click_filter that alone handles trusted clicks.
const COVERED = `<!doctype html><body>
<div style="position:relative;width:200px;height:40px">
  <button id="submit" style="position:absolute;inset:0">Submit</button>
  <div data-automation-id="click_filter" style="position:absolute;inset:0"
    onclick="if (event.isTrusted) document.body.innerHTML = '<h1>Thank you for applying!</h1>'"></div>
</div></body>`

function fakeEnv(page) {
  const state = { attempted: null, audits: [] }
  const ctx = {
    job: { id: 'j1', mode: 'auto', application_url: 'https://jobs.example.test/apply' }, allowedDomains: [], flags: [],
    stage: () => {}, heartbeat: async () => {}, step: async () => null, audit: async action => { state.audits.push(action) },
    db: { query: async sql => {
      if (sql.includes('submit_attempted_at=now()')) { if (state.attempted) return { rowCount: 0, rows: [] }; state.attempted = 'set'; return { rowCount: 1, rows: [{}] } }
      if (sql.includes('submit_attempted_at=NULL')) state.attempted = null
      return { rowCount: 1, rows: [] }
    } },
  }
  const env = { page, ctx, obs: { url: page.url(), frames: [page.mainFrame()] }, mode: 'auto', filled: [], shot: null }
  return { env, state }
}

async function withPage(t, body, fn) {
  let browser
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH }) } catch { return t.skip('no Playwright Chromium installed') }
  try {
    const page = await browser.newPage()
    await page.route('https://jobs.example.test/**', route => route.fulfill({ contentType: 'text/html', body }))
    await page.goto('https://jobs.example.test/apply')
    await fn(page)
  } finally {
    await browser.close()
  }
}

test('submit clicks through a covering click_filter and captures the confirmation', t => withPage(t, COVERED, async page => {
  const { env, state } = fakeEnv(page)
  const result = await makeSubmit(env)(() => clickEl(env, {}, page.locator('#submit')), { via: 'click' })
  assert.equal(JSON.parse(result.slice('submitted:'.length)).status, 'applied')
  assert.equal(state.attempted, 'set', 'the attempt stays recorded after a real submit')
}))

test('a submit that cannot be clicked releases the lock instead of leaving it stuck', t => withPage(t, '<button>Back</button>', async page => {
  const { env, state } = fakeEnv(page)
  const result = await makeSubmit(env)(() => clickEl(env, {}, page.locator('#missing')), { via: 'click' })
  assert.match(result, /^error:/)
  assert.equal(state.attempted, null, 'nothing was sent, so a corrected retry is allowed')
  assert.ok(state.audits.includes('submit_not_sent'))
}))

// An unreadable inbox code falls back to the owner through the existing ask/answer path.
for (const source of ['inbox', 'owner']) test(`review submit uses ${source} split email code before recording a real confirmation`, t => withPage(t,
  `<button id="submit" onclick="location.href='/confirmation'">Submit application</button>`, async page => {
    const challenge = `<h1>Confirmation</h1><p>A verification code was sent to profile@example.test. Enter the 8-character code</p>
      <input aria-label="First Name" value="Test"><input aria-label="Email" value="profile@example.test">
      <fieldset id="email-verification"><legend>A verification code was sent to profile@example.test. Enter the 8-character code</legend>
      <label aria-hidden="true" for="security-input-0">Security code</label><div class="email-verification__wrapper">${Array.from({ length: 8 }, (_, i) => `<input id="security-input-${i}" class="code" type="text" maxlength="1" aria-required="true" aria-errormessage="email-verification-error">`).join('')}</div></fieldset>
      <button type="submit" onclick="window.enteredCode=[...document.querySelectorAll('.code')].map(e=>e.value).join(''); if(window.enteredCode === 'AB12CD34') document.body.innerHTML='<h1>Thank you for applying!</h1>'">Submit application</button>`
    await page.route('https://jobs.example.test/confirmation', route => route.fulfill({ contentType: 'text/html', body: challenge }))
    assert.equal(looksConfirmed('Confirmation A verification code was sent. Enter the 8-character code Security code', 'https://jobs.example.test/confirmation'), false)
    const { env, state } = fakeEnv(page)
    env.mode = 'review'
    env.profile = { email: 'profile@example.test' }
    env.ctx.secrets = {}
    env.ctx.mail = { waitForVerification: async () => source === 'inbox' ? { code: 'AB12CD34' } : null }
    const receipts = []
    env.ctx.step = async (kind, detail) => { if (kind === 'receipt') receipts.push(detail) }
    let asked = 0
    env.ctx.ask = async q => {
      if (q.kind === 'approval') return 'Approve'
      asked++
      assert.equal(q.remember, false)
      assert.match(q.prompt, /profile@example.test/)
      assert.equal(state.attempted, 'set')
      assert.equal(receipts.length, 0, 'no receipt before the owner replies')
      assert.equal(await page.locator('.code').first().inputValue(), '')
      await page.waitForTimeout(50)
      return 'AB12CD34'
    }
    const result = await makeSubmit(env)(() => clickEl(env, {}, page.locator('#submit')), { via: 'click' })
    assert.equal(asked, source === 'owner' ? 1 : 0)
    assert.match(result, /^submitted:/)
    assert.equal(JSON.parse(result.slice('submitted:'.length)).status, 'applied')
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].confirmed, true)
    assert.equal(state.attempted, 'set')
    assert.equal(await page.locator('h1').innerText(), 'Thank you for applying!')
    assert.equal(await page.evaluate(() => window.enteredCode), 'AB12CD34')
  }))


test('an unrecognized post-submit code layout asks the owner instead of silently skipping', t => withPage(t,
  `<button id="submit" onclick="location.href='/confirmation'">Submit application</button>`, async page => {
    await page.route('https://jobs.example.test/confirmation', route => route.fulfill({ contentType: 'text/html', body:
      '<h1>Confirmation</h1><p>Enter the security code</p><input aria-label="Characters" maxlength="2"><button>Verify</button>' }))
    const { env, state } = fakeEnv(page)
    env.mode = 'review'
    let asked = 0
    let receipt
    env.ctx.step = async (kind, detail) => { if (kind === 'receipt') receipt = detail }
    env.ctx.ask = async q => {
      if (q.kind === 'approval') return 'Approve'
      asked++
      assert.equal(q.remember, false)
      assert.match(q.prompt, /could not be completed safely/)
      assert.equal(state.attempted, 'set')
      assert.equal(receipt, undefined)
      // Stand in for the owner completing the live controls before replying on Telegram.
      await page.evaluate(() => { document.body.innerHTML = '<h1>Thank you for applying!</h1>' })
      return 'Done'
    }
    const result = await makeSubmit(env)(() => clickEl(env, {}, page.locator('#submit')), { via: 'click' })
    assert.equal(asked, 1)
    assert.match(result, /^submitted:/)
    assert.equal(JSON.parse(result.slice('submitted:'.length)).status, 'applied')
    assert.equal(receipt.confirmed, true)
    assert.equal(state.attempted, 'set')
  }))

test('a last-poll challenge gets a fresh post-Verify window and secret-safe diagnostics', t => withPage(t,
  '<button id="submit" onclick="document.body.innerHTML=\'<h1>Processing</h1>\'">Submit application</button>', async page => {
    const { env, state } = fakeEnv(page)
    env.ctx.secrets = {}
    env.profile = { email: 'profile@example.test' }
    env.ctx.mail = { waitForVerification: async () => ({ code: 'AB12CD34' }) }
    const logs = []
    t.mock.method(console, 'log', (...args) => { logs.push(args.join(' ')) })
    let before = 0, after = 0
    const wait = page.waitForTimeout.bind(page)
    page.waitForTimeout = async ms => {
      if (ms === 1500) {
        if (await page.evaluate(() => Boolean(window.verifying))) {
          after++
          if (after === 5) await page.evaluate(() => {
            document.body.innerHTML = '<h1>Thank you for applying!</h1><p>AB12CD34 profile@example.test</p>'
            history.replaceState(null, '', '/confirmation?code=AB12CD34')
          })
        } else {
          before++
          if (before === 10) await page.evaluate(() => {
            document.body.innerHTML = `<input aria-label="First Name" value="Test">
              <fieldset id="email-verification"><legend>Enter the security code</legend>
              <label for="code">Security code</label><input id="code"></fieldset>
              <button onclick="if(document.querySelector('#code').value === 'AB12CD34') window.verifying=true">Verify</button>`
          })
        }
      }
      await wait(1)
    }
    const result = await makeSubmit(env)(() => clickEl(env, {}, page.locator('#submit')), { via: 'click' })
    assert.match(result, /^submitted:/)
    assert.equal(JSON.parse(result.slice('submitted:'.length)).status, 'applied')
    assert.equal(before, 10)
    assert.equal(after, 5, 'confirmation must be observed after the initial ten polls are exhausted')
    assert.equal(state.attempted, 'set')
    const output = logs.join('\n')
    for (const event of ['challenge_detected', 'box_count', 'inbox', 'found', 'elapsed_ms', 'concatenated_length', 'length_matches', 'verify_clicked', 'confirmation_window', 'final']) assert.ok(output.includes(event), event)
    assert.ok(output.includes('30000'))
    assert.ok(!output.includes('AB12CD34'))
    assert.ok(!output.includes('profile@example.test'))
    assert.ok(!output.includes('?code='))
  }))
