// Park and resume without re-planning: what a parked run filled is put back on a fresh page with no model calls,
// through dispatch (so every safety rule still applies). Needs a Chromium; no database.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { Stop } from './context.mjs'
import { observe } from './perception/walk.mjs'
import { dispatch } from './actions/registry.mjs'
import { setModelBackend } from './gemini.mjs'
import { restoreFilled, restorePending } from './restore.mjs'

// Greenhouse-shaped: text fields, a react-select style combobox, a checkbox group whose boxes carry option ids,
// a resume file input, two fields with the same label, and a question the applicant answers.
const page_ = ({ last = 'Last name' } = {}) => `<!doctype html><body><form action="/submit" method="post">
<label for="fn">First name *</label><input id="fn" required>
<label for="ln">${last} *</label><input id="ln" required>
<label id="cl">Country *</label>
<div id="country" role="combobox" tabindex="0" aria-labelledby="cl" aria-expanded="false" style="border:1px solid #888;padding:6px">Select...</div>
<ul id="lb" role="listbox" hidden></ul>
<fieldset><legend>Languages you use</legend><label><input id="py" type="checkbox" value="731172288"> Python</label><label><input id="go" type="checkbox" value="731172289"> Go</label></fieldset>
<label for="cv">Resume *</label><input id="cv" type="file" required>
<label for="y1">Start date year</label><input id="y1">
<label for="y2">Start date year</label><input id="y2">
<label for="q">Years of Zig *</label><input id="q" required>
<button type="submit">Submit application</button></form>
<script>
const C=['Germany','India','Ireland'];let open=false,typed='';
const render=()=>{lb.innerHTML=C.filter(c=>c.toLowerCase().startsWith(typed)).map(c=>'<li role="option">'+c+'</li>').join('')}
country.onclick=()=>{open=!open;typed='';render();lb.hidden=!open;country.setAttribute('aria-expanded',open)}
addEventListener('keydown',e=>{if(open&&e.key.length===1){typed+=e.key.toLowerCase();render()}if(open&&e.key==='Enter'){const f=lb.querySelector('[role=option]');if(f)f.click();e.preventDefault()}})
lb.onclick=e=>{if(e.target.getAttribute('role')==='option'){country.textContent=e.target.textContent;open=false;lb.hidden=true;country.setAttribute('aria-expanded','false')}}
</script></body>`

function makeEnv(page, file, ask, filled = []) {
  const ctx = {
    job: { id: 'job-1', application_url: 'https://example.com/apply' }, stats: { safety_violations: 0 }, secrets: {}, flags: [],
    flag: async () => {}, step: async () => null, notify: async () => {}, audit: async () => {}, stage: () => {}, heartbeat: async () => {},
    db: { query: async () => ({ rows: [], rowCount: 0 }) },
  }
  ctx.ask = opts => ask(opts, ctx)
  ctx.filled = filled
  return { page, ctx, profile: { first_name: 'Aarav', last_name: 'Mehta' }, bank: [], upload: async () => file, mode: 'review', filled, platform: 'custom', shot: null, submit: async () => 'error:not in this test' }
}

const act = async (env, a) => {
  env.obs = await observe(env.page)
  const ref = env.obs.elements.find(e => e.label === a.label)?.ref
  assert.ok(ref, `field ${a.label}`)
  return dispatch(env, { ...a, ref, source: 'inferred', confidence: 'medium' })
}
const nth = async (env, label, i, value) => {
  env.obs = await observe(env.page)
  const ref = env.obs.elements.filter(e => e.label === label)[i].ref
  return dispatch(env, { action: 'fill', ref, value, source: 'inferred', confidence: 'medium' })
}

// The parked run: fill everything, then the question parks the job (the stub ask throws the park Stop).
async function parkedRun(page, file) {
  await page.setContent(page_())
  let pending = null
  const env = makeEnv(page, file, async (_, ctx) => { pending = ctx.pendingAsk; throw new Stop('needs_user', 'parked', { parked: true }) })
  for (const a of [
    { action: 'fill', label: 'First name *', value: 'Aarav' },
    { action: 'fill', label: 'Last name *', value: 'Mehta' },
    { action: 'choose', label: 'Country *', value: 'India' },
    { action: 'check', label: 'Languages you use > Python' },
    { action: 'upload', label: 'Resume *', doc: 'resume' },
  ]) assert.match((await act(env, a)).result, /^ok/, a.label)
  assert.match((await nth(env, 'Start date year', 0, '2019')).result, /^ok/)
  assert.match((await nth(env, 'Start date year', 1, '2021')).result, /^ok/)
  await assert.rejects(act(env, { action: 'ask_human', label: 'Years of Zig *', question: 'How many years of Zig?' }), e => e.parked)
  assert.ok(pending, 'the checkpoint knows which field the question was for')
  return { filled: env.filled, pending }
}

test('a resumed run restores the parked run\'s values and answer with no model calls', async t => {
  let browser
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }) } catch { return t.skip('no Playwright Chromium installed') }
  const file = path.join(os.tmpdir(), `restore-test-${process.pid}.pdf`)
  await writeFile(file, '%PDF-1.4\n%%EOF\n')
  let modelCalls = 0
  setModelBackend(async () => { modelCalls++; throw new Error('no model in this test') })
  try {
    const { filled, pending } = await parkedRun(await browser.newPage(), file)
    assert.equal(filled.find(f => f.label === 'Languages you use > Python').value, 'checked')
    assert.equal(filled.find(f => f.label === 'Resume *').action, 'upload')

    // Resume: a fresh page (as in a new browser), the checkpoint's values, and your answer to the question.
    const page = await browser.newPage()
    await page.setContent(page_())
    const asked = []
    const env = makeEnv(page, file, async opts => { asked.push(opts.prompt); return '3' }, [...filled])
    env.obs = await observe(page)
    const restored = await restoreFilled(env, env.obs, filled)
    assert.deepEqual(restored.map(r => r.label).sort(), ['Country *', 'First name *', 'Languages you use > Python', 'Last name *', 'Resume *', 'Start date year', 'Start date year'])
    assert.deepEqual(env.filled, filled, 'restoring keeps the approval summary (and its hash) exactly as before the park')

    env.obs = await observe(page)
    assert.equal(await restorePending(env, env.obs, pending), 'Years of Zig *')
    assert.deepEqual(asked, ['How many years of Zig?'], 'the same prompt, so the answer given while parked is reused')
    assert.equal(await restorePending(env, await observe(page), pending), null, 'the pending question is used once')

    assert.equal(await page.inputValue('#fn'), 'Aarav')
    assert.equal(await page.inputValue('#ln'), 'Mehta')
    assert.equal(await page.locator('#country').innerText(), 'India')
    assert.equal(await page.isChecked('#py'), true)
    assert.equal(await page.isChecked('#go'), false)
    assert.equal(await page.locator('#cv').evaluate(el => el.files.length), 1)
    assert.equal(await page.inputValue('#y1'), '2019', 'same-label fields keep their own values')
    assert.equal(await page.inputValue('#y2'), '2021')
    assert.equal(await page.inputValue('#q'), '3')
    assert.equal(modelCalls, 0)

    // Running restore again on the same page changes nothing (fields are filled, entries are used).
    assert.deepEqual(await restoreFilled(env, await observe(page), filled), [])
  } finally {
    setModelBackend(null)
    await browser.close()
  }
})

test('a field whose label changed while parked is skipped and left to the planner', async t => {
  let browser
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }) } catch { return t.skip('no Playwright Chromium installed') }
  const file = path.join(os.tmpdir(), `restore-test-${process.pid}-2.pdf`)
  await writeFile(file, '%PDF-1.4\n%%EOF\n')
  setModelBackend(async () => { throw new Error('no model in this test') })
  try {
    const { filled } = await parkedRun(await browser.newPage(), file)
    const page = await browser.newPage()
    await page.setContent(page_({ last: 'Surname' }))
    const env = makeEnv(page, file, async () => '3', [...filled])
    env.obs = await observe(page)
    const restored = await restoreFilled(env, env.obs, filled)
    assert.ok(!restored.some(r => r.label === 'Surname *'))
    assert.equal(await page.inputValue('#ln'), '', 'never forced into a renamed field')
    assert.equal(await page.inputValue('#fn'), 'Aarav')
    assert.equal(await page.locator('#country').innerText(), 'India')
  } finally {
    setModelBackend(null)
    await browser.close()
  }
})
