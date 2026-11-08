// Guard check for the Stagehand engine, before it may score anything: Stagehand drives the browser through its
// own extension over CDP, so this proves our network guard (Playwright routes on the same browser) still blocks a
// submit that Stagehand clicks. Model-free (act() with an already-observed action). Needs a Chromium.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createPolicy } from '../worker/lib/security.mjs'
import { launchGuarded } from '../worker/engines/stagehand.mjs'

const skip = !process.env.CHROMIUM_PATH

const FORM = `<!doctype html><title>Apply</title><body><form action="/submit" method="post">
<label for="fn">First name</label><input id="fn" name="fn" value="Aarav">
<button type="submit" id="go">Submit application</button></form></body>`

test('a submit clicked by Stagehand is blocked by our guard in dry run', { skip, timeout: 120000 }, async () => {
  let posts = 0
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') { posts++; res.end('<h1>Thank you for applying!</h1>'); return }
    res.setHeader('content-type', 'text/html'); res.end(FORM)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/apply`
  // No submit-event block here: the guard alone has to stop the POST.
  const g = await launchGuarded({ jobUrl: url, policy: createPolicy({ allowLoopback: true }), dryRun: true, blockSubmitEvent: false, generate: async () => { throw new Error('no model in this test') } })
  try {
    await g.page.goto(url)
    const r = await g.stagehand.act({ selector: 'xpath=//button[@id="go"]', description: 'Submit application button', method: 'click' })
    await g.page.waitForTimeout(1500)
    assert.equal(posts, 0, 'nothing reached the server')
    assert.ok(g.writes.blocked >= 1, `the guard saw and blocked the submit (act said: ${JSON.stringify(r?.data?.message || r)})`)
    assert.ok(g.writes.log.some(w => w.method === 'POST' && /\/submit/.test(w.url) && !w.allowed))
  } finally {
    await g.close(); await new Promise(r => server.close(r))
  }
})

test('Stagehand model calls go to our Gemini backend: JSON-schema answers and tool calls are translated', async () => {
  const { setModelBackend } = await import('../worker/lib/gemini.mjs')
  const { stagehandModel } = await import('../worker/engines/stagehand.mjs')
  const seen = []
  setModelBackend(async opts => {
    seen.push(opts)
    if (opts.config.responseMimeType === 'application/json') return { text: '```json\n{"elements":[{"id":"1"}]}\n```', usage: { in: 120, out: 8 } }
    return { text: '', functionCalls: [{ name: 'click', args: { id: '1' } }], usage: { in: 50, out: 4 } }
  })
  const counted = []
  try {
    const m = stagehandModel({ meter: { add: (model, i, o) => counted.push([i, o]) } })
    const j = await m.generate({ systemPrompt: 'find', messages: [{ role: 'user', content: [{ type: 'text', text: 'page' }, { type: 'image', data: 'aGk=', mimeType: 'image/png' }] }], responseFormat: { type: 'json_schema', name: 'x', schema: { type: 'object' } } })
    assert.deepEqual(j.structuredContent, { elements: [{ id: '1' }] })
    assert.equal(j.outputFormat, 'json_schema')
    assert.deepEqual(j.usage, { inputTokens: 120, outputTokens: 8, totalTokens: 128 })
    assert.equal(seen[0].config.systemInstruction, 'find')
    assert.deepEqual(seen[0].contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'aGk=' } })
    const t = await m.generate({ messages: [{ role: 'user', content: { type: 'text', text: 'go' } }], tools: [{ name: 'click', inputSchema: { type: 'object' } }], toolChoice: { mode: 'required' } })
    assert.equal(t.content[0].type, 'tool_use'); assert.equal(t.content[0].name, 'click'); assert.deepEqual(t.content[0].input, { id: '1' })
    assert.equal(seen[1].config.toolConfig.functionCallingConfig.mode, 'ANY')
    assert.deepEqual(counted, [[120, 8], [50, 4]], 'every call is metered')
  } finally {
    setModelBackend(null)
  }
})

test('Stagehand values come from your facts, not from the model', async () => {
  const { factFor } = await import('../worker/engines/stagehand.mjs')
  const profile = { first_name: 'Jane', last_name: 'Doe', email: 's@example.com', sensitive: { gender: { value: 'Male', mode: 'ask' } } }
  const bank = [{ question: 'Notice period', answer: 'Immediate' }]
  assert.equal(factFor('First Name*', profile, bank), 'Jane')
  assert.equal(factFor('Notice Period', profile, bank), 'Immediate')
  assert.equal(factFor('Gender', profile, bank), null, 'a sensitive field set to ask is never answered from facts')
  assert.equal(factFor('Current CTC', profile, bank), null, 'unknown: asked, not invented')
})

test('the résumé goes to the Resume field, not an "Autofill from resume" helper above it (Ashby)', { skip, timeout: 60000 }, async () => {
  const { chromium } = await import('playwright')
  const { resumeInput } = await import('../worker/engines/stagehand.mjs')
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  try {
    const page = await browser.newPage()
    await page.setContent(`<div><h3>Autofill from resume</h3><label for="auto">Upload file</label><input id="auto" type="file"></div>
      <label for="fn">Name</label><input id="fn">
      <div><label for="cv">Resume</label><input id="cv" type="file"></div>`)
    const input = await resumeInput(page)
    assert.equal(await input.getAttribute('id'), 'cv')
  } finally {
    await browser.close()
  }
})
