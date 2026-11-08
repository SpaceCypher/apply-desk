import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { observe } from './observe.mjs'
import { groupPicks } from './actions/registry.mjs'

// Greenhouse-style "check all that apply" group.
const PAGE = `<!doctype html><body><fieldset><legend>Internship Information: please select the cohort dates</legend>
<label><input type="checkbox" name="c"> January to June (6 months)</label>
<label><input type="checkbox" name="c"> May to July (10 weeks)</label>
<label><input type="checkbox" name="c"> June to August (10 weeks)</label>
<label><input type="checkbox" name="c"> None of these options work for me</label></fieldset></body>`

test('a checkbox-group answer picks exactly the named options', async t => {
  let browser
  try { browser = await chromium.launch() } catch { return t.skip('no Playwright Chromium installed') }
  try {
    const page = await browser.newPage()
    await page.setContent(PAGE)
    const obs = await observe(page)
    const boxes = obs.elements.filter(e => e.type === 'checkbox')
    assert.equal(boxes.length, 4)
    const picks = groupPicks(obs.elements, boxes[0], 'May to July, June to August')
    assert.deepEqual(picks.map(p => p.ref), [boxes[1].ref, boxes[2].ref])
    assert.deepEqual(groupPicks(obs.elements, boxes[0], 'nothing like this').map(p => p.ref), [boxes[0].ref], 'no match falls back to the target')
  } finally {
    await browser.close()
  }
})

test('a factual question is asked rather than filled with a guess or a placeholder', async () => {
  const { enforce } = await import('./actions/registry.mjs')
  const obs = { elements: [
    { ref: '1', tag: 'input', type: 'text', role: 'textbox', label: 'Current CTC' },
    { ref: '2', tag: 'textarea', role: 'textbox', label: "Please share some content you've created" },
    { ref: '3', tag: 'input', type: 'text', role: 'textbox', label: 'City' },
    { ref: '4', tag: 'textarea', role: 'textbox', label: 'Why do you want to work here?' },
  ] }
  const env = { profile: { first_name: 'Aarav', location: 'Bengaluru, India', github: 'https://github.com/aarav' }, bank: [{ question: 'Notice period', answer: 'Immediate' }] }
  const fill = (ref, value, source = 'inferred') => enforce({ action: 'fill', ref, value, source, confidence: 'medium' }, obs, env)
  assert.equal(fill('1', 'N/A').action, 'ask_human', 'placeholder')
  assert.equal(fill('1', 'None', 'profile').action, 'ask_human', 'placeholder even when claimed from the profile')
  assert.equal(fill('2', 'I have built and documented several open-source projects').action, 'ask_human', 'made-up prose for a factual question')
  assert.equal(fill('2', 'https://github.com/aarav').action, 'fill', 'a value backed by the profile is fine')
  assert.equal(fill('3', 'Bengaluru').action, 'fill', 'inferred from the profile location')
  assert.equal(fill('1', 'Immediate', 'answer_bank').action, 'fill')
  assert.equal(fill('4', 'I admire the product and the team.').action, 'fill', 'judgement questions (essays) are not facts')
})

test('date parts and essays about experience are not treated as factual questions to ask', async () => {
  const { enforce } = await import('./actions/registry.mjs')
  const obs = { elements: [
    { ref: '1', tag: 'input', type: 'text', role: 'textbox', label: 'Start date year' },
    { ref: '2', tag: 'textarea', role: 'textbox', label: 'Describe your experience designing a backend service' },
    { ref: '3', tag: 'input', type: 'text', role: 'textbox', label: 'What is your total years of work experience?' },
  ] }
  const env = { profile: { first_name: 'Aarav' }, bank: [] }
  const fill = (ref, value) => enforce({ action: 'fill', ref, value, source: 'inferred', confidence: 'medium' }, obs, env).action
  assert.equal(fill('1', '2019'), 'fill')
  assert.equal(fill('2', 'I built a queue service in Go.'), 'fill')
  assert.equal(fill('3', '2'), 'ask_human')
})
