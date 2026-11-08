import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { workdayPass } from './workday.mjs'

// A Workday-like page: Apply stays visible behind the dialog, and the phone field reformats what is typed.
const PAGE = `<!doctype html><body>
<button data-automation-id="adventureButton" onclick="document.getElementById('dlg').hidden=false">Apply</button>
<div id="dlg" hidden>
  <button data-automation-id="autofillWithResume" onclick="history.pushState({}, '', '/info'); document.body.innerHTML = document.getElementById('info').innerHTML">Autofill with Resume</button>
  <button data-automation-id="applyManually">Apply Manually</button>
</div>
<template id="info">
  <input data-automation-id="legalNameSection_firstName">
  <input data-automation-id="phone-number" oninput="this.value = this.value.replace(/(\\d{5})(\\d+)/, '$1 $2')">
</template>
</body>`

test('workday: prefers autofill, and hands a page to the planner once its fixed steps are done', async t => {
  let browser
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }) } catch { return t.skip('no Playwright Chromium installed') }
  try {
    const page = await browser.newPage()
    await page.route('https://jobs.example.test/**', route => route.fulfill({ contentType: 'text/html', body: PAGE }))
    await page.goto('https://jobs.example.test/job')
    const ctx = { job: { mode: 'review' }, secrets: {} }
    const profile = { first_name: 'Jane', phone: '+1 2025550142' }
    const pass = () => workdayPass(page, ctx, profile, async () => null)

    assert.equal(await pass(), 'opened apply')
    assert.equal(await pass(), 'chose autofill with resume', 'the dialog wins over the Apply button still behind it')
    assert.equal(await pass(), 'filled standard fields')
    assert.equal(await page.locator('[data-automation-id="phone-number"]').inputValue(), '20255 50142')
    assert.equal(await pass(), null, 'a reformatted value is not refilled forever; the planner takes over')
  } finally {
    await browser.close()
  }
})

// Workday's wiring: the real button sits under a click_filter that alone handles (trusted) clicks,
// and a password popover covers both until Escape.
const SIGNUP = `<!doctype html><body>
<input data-automation-id="email"><input data-automation-id="password" type="password"><input data-automation-id="verifyPassword" type="password">
<div style="position:relative;width:200px;height:40px">
  <button data-automation-id="createAccountSubmitButton" style="position:absolute;inset:0">Create Account</button>
  <div data-automation-id="click_filter" role="button" aria-label="Create Account" style="position:absolute;inset:0" onclick="if (event.isTrusted) window.created = true"></div>
</div>
<div id="pop" data-behavior-click-outside-close="topmost" style="position:fixed;inset:0;background:#0001"></div>
<script>addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('pop').remove() })</script>
</body>`

test('workday: creates the account even when a popover covers the button', async t => {
  let browser
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }) } catch { return t.skip('no Playwright Chromium installed') }
  process.env.VAULT_KEY ||= Buffer.alloc(32, 7).toString('base64')
  process.env.JOB_GMAIL_ADDRESS ||= 'jobs@example.test'
  try {
    const page = await browser.newPage()
    await page.route('https://jobs.example.test/**', route => route.fulfill({ contentType: 'text/html', body: SIGNUP }))
    await page.goto('https://jobs.example.test/signup')
    const stored = []
    // Remembers the inserted login, as the real table would (the code reads it back after storing it).
    let row = null
    const query = async (sql, params) => {
      stored.push(sql)
      if (sql.startsWith('INSERT INTO credentials')) row = { username_enc: params[1], password_enc: params[2], created_at: new Date() }
      return { rows: sql.includes('FROM credentials') && row ? [row] : [] }
    }
    const ctx = { job: { mode: 'review' }, secrets: {}, db: { query }, audit: async () => {} }
    const started = Date.now()
    assert.equal(await workdayPass(page, ctx, {}, async () => null), 'created account')
    assert.equal(await page.evaluate(() => window.created), true)
    assert.ok(stored.some(sql => sql.startsWith('INSERT INTO credentials')), 'credential stored before submit')
    assert.ok(Date.now() - started < 15000, 'no 30 second click waits')
  } finally {
    await browser.close()
  }
})

test('workday: waits for delayed application controls instead of planning against the shell', async t => {
  const { waitForWorkday } = await import('./workday.mjs')
  let browser
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }) } catch { return t.skip('no Playwright Chromium installed') }
  try {
    const page = await browser.newPage()
    await page.setContent(`<header>Sign In</header><script>setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<input data-automation-id="email">') }, 1800)</script>`)
    await waitForWorkday(page, 5000)
    assert.equal(await page.locator('[data-automation-id="email"]').isVisible(), true)
  } finally { await browser.close() }
})


test('Phenom: accepts one public Workday apply destination, refuses external or ambiguous data', async () => {
  const { workdayApplyUrl } = await import('./workday.mjs')
  const url = 'https://example.wd1.myworkdayjobs.com/Example_External/job/Engineer_SAMPLE001/apply'
  assert.equal(workdayApplyUrl(JSON.stringify({ applyUrl: url })), url)
  assert.equal(workdayApplyUrl(JSON.stringify([{ applyUrl: url }, { applyUrl: url }])), url)
  for (const bad of ['https://evil.example/apply', 'http://example.wd1.myworkdayjobs.com/apply', 'https://example.wd1.myworkdayjobs.com.evil.example/apply', 'https://user@example.wd1.myworkdayjobs.com/apply'])
    assert.equal(workdayApplyUrl(JSON.stringify({ applyUrl: bad })), null)
  assert.equal(workdayApplyUrl(JSON.stringify([{ applyUrl: url }, { applyUrl: url.replace('example.', 'adobe.') }])), null)
})
