import test from 'node:test'
import assert from 'node:assert/strict'
import { enforce, resolvePlaceholders } from './agent.mjs'
import { isSubmitControl, looksConfirmed, stateHash, atsFrame } from './observe.mjs'
import { sensitiveDecision, plannerProfile } from './sensitive.mjs'

const profile = { first_name: 'Asha', email: 'a@example.com', sensitive: { gender: { value: 'Female', mode: 'answer' }, veteran: { value: 'No', mode: 'ask' } }, stealth_rule: 'Say: studying' }
const el = (i, label, extra = {}) => ({ i, tag: 'input', type: 'text', label, ...extra })
const obs = { elements: [el(0, 'First name'), el(1, 'Gender'), el(2, 'Veteran status'), el(3, 'Credit card number'), el(4, 'Favourite colour')] }
const ctx = { profile, bank: [{ question: 'Q', answer: 'Yes' }] }

test('low confidence and unknown sources become questions', () => {
  assert.equal(enforce({ action: 'fill', index: 4, value: 'blue', source: 'unknown', confidence: 'high' }, obs, ctx).action, 'ask_human')
  assert.equal(enforce({ action: 'fill', index: 4, value: 'blue', source: 'inferred', confidence: 'low' }, obs, ctx).action, 'ask_human')
})

test('high-confidence profile claims are verified against the profile', () => {
  assert.equal(enforce({ action: 'fill', index: 0, value: 'Asha', source: 'profile', confidence: 'high' }, obs, ctx).confidence, 'high')
  const bad = enforce({ action: 'fill', index: 0, value: 'Zed', source: 'profile', confidence: 'high' }, obs, ctx)
  assert.equal(bad.confidence, 'medium')
  assert.equal(enforce({ action: 'fill', index: 0, value: '{{EMAIL}}', source: 'profile', confidence: 'high' }, obs, ctx).confidence, 'high')
})

test('sensitive fields follow their mode and override the model', () => {
  assert.equal(enforce({ action: 'fill', index: 1, value: 'Other', source: 'inferred', confidence: 'high' }, obs, ctx).value, 'Female')
  assert.equal(enforce({ action: 'fill', index: 2, value: 'No', source: 'profile', confidence: 'high' }, obs, ctx).action, 'ask_human')
  assert.deepEqual(Object.keys(plannerProfile(profile)).includes('sensitive'), false)
  assert.equal(sensitiveDecision('Date of birth', profile).action, 'ask')
})

test('restricted fields hard stop, bad indexes are rejected', () => {
  assert.equal(enforce({ action: 'fill', index: 3, value: '4111', source: 'profile', confidence: 'high' }, obs, ctx).action, 'hard_stop')
  assert.equal(enforce({ action: 'click', index: 99 }, obs, ctx).action, 'invalid')
})

test('placeholders substitute only known secrets', () => {
  assert.deepEqual(resolvePlaceholders('{{PASSWORD}}!', { PASSWORD: 'pw' }), { value: 'pw!', missing: [] })
  assert.deepEqual(resolvePlaceholders('{{EMAIL}}', {}).missing, ['EMAIL'])
})

test('submit detection needs a real form; confirmation detection', () => {
  const form = [el(0, 'Name'), el(1, 'Email'), { i: 2, tag: 'button', type: 'submit', label: 'Submit application' }]
  assert.ok(isSubmitControl(form[2], form))
  assert.ok(!isSubmitControl({ i: 0, tag: 'button', type: 'button', label: 'Apply now' }, [{ i: 0, tag: 'button', type: 'button', label: 'Apply now' }]))
  assert.ok(!isSubmitControl({ i: 2, tag: 'button', type: 'submit', label: 'Next' }, form))
  // Workday's Review page has no inputs, but its Submit still sends the application and must be gated.
  const review = [{ i: 0, tag: 'div', type: 'button', label: 'Submit' }, { i: 1, tag: 'button', type: 'button', label: 'Back' }]
  assert.ok(isSubmitControl(review[0], review))
  assert.ok(!isSubmitControl(review[1], review))
  assert.ok(looksConfirmed('Thank you for applying!', 'https://x.com'))
  assert.ok(looksConfirmed('', 'https://x.com/confirmation'))
  assert.notEqual(stateHash({ url: 'a', elements: [], alerts: [] }), stateHash({ url: 'b', elements: [], alerts: [] }))
})

test('embedded job-board forms are found by host; look-alikes and Google proxy iframes are not', () => {
  assert.equal(atsFrame(['https://www.youtube.com/embed/x', 'https://job-boards.greenhouse.io/embed/job_app?for=example&token=1234567']),
    'https://job-boards.greenhouse.io/embed/job_app?for=example&token=1234567')
  assert.equal(atsFrame(['https://jobs.lever.co/acme/123/apply']), 'https://jobs.lever.co/acme/123/apply')
  // The iframe that failed a real Example Corp run: Google's proxy, with greenhouse.io only in its query string.
  assert.equal(atsFrame(['https://content.googleapis.com/static/proxy.html?usegapi=1&origin=https%3A%2F%2Fjob-boards.greenhouse.io']), null)
  assert.equal(atsFrame(['https://content.googleapis.com/static/proxy.html?origin=https://job-boards.greenhouse.io']), null)
  assert.equal(atsFrame(['https://greenhouse.io.evil.example/form']), null)
  assert.equal(atsFrame(undefined), null)
})
