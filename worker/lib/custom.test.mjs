import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { observe, isSubmitControl } from './perception/walk.mjs'
import { looksBotBlocked } from './security.mjs'
import { dispatch, makeSubmit } from './actions/registry.mjs'

async function withPage(t, html, fn) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  try {
    const page = await browser.newPage()
    await page.setContent(html)
    await fn(page)
  } finally { await browser.close() }
}

const skip = !process.env.CHROMIUM_PATH

test('custom: an empty AWS WAF challenge is observed as a bot wall, not a job page', { skip }, t => withPage(t,
  '<div id="challenge-container"></div><script src="https://tenant.token.awswaf.com/id/challenge.js" type="application/json"></script><script>window.challengePending = true</script>', async page => {
    const obs = await observe(page)
    assert.equal(obs.text, '')
    assert.equal(obs.botBlocked, true)
    // A challenge script on a populated application page is not enough to declare it blocked.
    await page.setContent('<h1>Apply</h1><label>Name<input></label><script src="https://tenant.token.awswaf.com/id/challenge.js" type="application/json"></script>')
    assert.equal((await observe(page)).botBlocked, false)
  }))

test('custom: HTTP Forbidden pages are recognised as bot/access walls', () => {
  assert.equal(looksBotBlocked('403 Forbidden', '403 Forbidden'), true)
  assert.equal(looksBotBlocked('Build software for 403 customers', 'Engineer'), false)
})

// SuccessFactors-style marketing page: unrelated search/alert forms and an Apply dropdown with default type=submit.
const LANDING = `<form id="search"><input aria-label="Search by Keyword"><input aria-label="Search by Location"></form>
<form id="alerts"><input aria-label="Email alerts"><button>Create Alert</button></form>
<button id="apply" aria-haspopup="true" onclick="document.querySelector('#menu').hidden=false">Apply now</button>
<div id="menu" hidden><a role="menuitem" href="#application">Apply Now</a></div>
<form id="application"><label>Name<input value="Test"></label><label>Email<input type="email" value="test@example.test"></label>
<button>Apply</button><button type="button">Submit application</button></form>`

test('custom: Apply dropdown ignores other forms; final Apply still gates, including externally owned buttons', { skip }, t => withPage(t, LANDING, async page => {
  let obs = await observe(page)
  const trigger = obs.elements.find(e => e.label === 'Apply now')
  assert.equal(isSubmitControl(trigger, obs.elements), false)
  const env = {
    page, obs, mode: 'dry_run', filled: [], profile: {}, bank: [],
    ctx: { job: { mode: 'dry_run', application_url: 'https://example.test/job' }, stage() {}, step: async () => {}, stats: {} },
  }
  env.submit = makeSubmit(env)
  assert.equal((await dispatch(env, { action: 'click', ref: trigger.ref })).result, 'ok')
  assert.equal(await page.locator('#menu').isVisible(), true)
  obs = env.obs = await observe(page)
  for (const label of ['Apply', 'Submit application']) {
    const button = obs.elements.find(e => e.label === label)
    assert.equal((await dispatch(env, { action: 'click', ref: button.ref })).result, 'dry_run_done', label)
  }
  await page.evaluate(() => { const b = document.createElement('button'); b.textContent = 'Apply'; b.setAttribute('form', 'application'); document.body.append(b) })
  obs = await observe(page)
  const external = obs.elements.filter(e => e.label === 'Apply').at(-1)
  assert.equal(isSubmitControl(external, obs.elements), true, 'form= owner is respected')
  await page.evaluate(() => { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Apply'; document.body.append(b) })
  obs = await observe(page)
  assert.equal(isSubmitControl(obs.elements.filter(e => e.label === 'Apply').at(-1), obs.elements), true, 'ordinary unowned JavaScript submit stays gated')
}))

test('custom: recognised ATS handoffs are allowed, look-alikes and dry-run writes remain blocked', async () => {
  const { isAllowedHost } = await import('./security.mjs')
  const { decideRequest } = await import('./guard.mjs')
  const job = 'https://careers.employer.example/job/1'
  for (const host of ['employer.avature.net', 'career5.successfactors.eu', 'career.successfactors.com', 'tenant.fa.oraclecloud.com']) {
    const allowedHost = isAllowedHost(host, job)
    assert.equal(allowedHost, true, host)
    assert.equal(decideRequest({ method: 'GET', navigation: true, allowedHost, dryRun: true }).allow, true)
    assert.equal(decideRequest({ method: 'POST', navigation: true, allowedHost, dryRun: true }).allow, false)
    assert.equal(isAllowedHost(host + '.evil.example', job), false)
  }
  assert.equal(isAllowedHost('unrelated.example', job), false)
})
