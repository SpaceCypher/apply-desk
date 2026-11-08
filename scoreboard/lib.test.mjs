import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanLabel, satisfies, scorePage, questions } from './lib.mjs'
import { graphqlRead } from '../worker/lib/guard.mjs'

test('labels lose the repeated placeholder and the asterisk', () => {
  assert.equal(cleanLabel('First Name* First Name'), 'First Name')
  assert.equal(cleanLabel('Will you require sponsorship?*'), 'Will you require sponsorship?')
  assert.equal(cleanLabel('New York New York City'), 'New York New York City')
})

test('expected values: text, choices, phone digits, checkbox groups, regex, must-be-empty', () => {
  assert.ok(satisfies('State University', 'state university'))
  assert.ok(satisfies('+91 20255 50143', '2025550143'))
  assert.ok(!satisfies('Aarhus University', 'State University'))
  assert.ok(satisfies(['Python', 'Go'], ['go', 'python']))
  assert.ok(!satisfies(['Python'], ['go', 'python']))
  assert.ok(satisfies("Bachelor's Degree", { regex: '^bachelor' }))
  assert.ok(satisfies('', ''))
  assert.ok(!satisfies('something', ''))
})

test('a page is scored against its key; only required entries count; empty required fields are reported', () => {
  const el = (label, extra = {}) => ({ tag: 'input', type: 'text', role: 'textbox', label, ...extra })
  const obs = {
    alerts: [],
    elements: [
      el('First Name* First Name', { value: 'Aarav', required: true }),
      el('School*', { role: 'combobox', value: 'Aarhus University', required: true }),
      el('Resume/CV* Attach', { type: 'file', role: 'file', file: true, value: 'Aarav_Resume.pdf' }),
      el('Languages > Python', { type: 'checkbox', role: 'checkbox', checked: true }),
      el('Languages > Go', { type: 'checkbox', role: 'checkbox', checked: false }),
      el('Phone', { required: true, value: '' }),
    ],
  }
  assert.deepEqual(questions(obs).find(q => q.label === 'Languages').value, ['Python'])
  const r = scorePage(obs, { entries: [
    { label: 'First Name', expected: 'Aarav', required: true },
    { label: 'School*', expected: 'State University', required: true },
    { label: 'Resume/CV* Attach', kind: 'file', expected: 'resume', required: true },
    { label: 'Languages', expected: ['Python'], required: false },
  ] })
  assert.equal(r.total, 3); assert.equal(r.correct, 2)
  assert.deepEqual(r.wrong.map(w => w.label), ['School*'])
  assert.equal(r.resume_ok, true)
  assert.deepEqual(r.empty_required, ['Phone'])
})

test('the guard lets GraphQL queries through (they only read) but never a mutation', () => {
  const req = (body, ct = 'application/json') => ({ method: () => 'POST', headers: () => ({ 'content-type': ct }), postData: () => JSON.stringify(body) })
  assert.ok(graphqlRead(req({ operationName: 'ApiJobPosting', query: 'query ApiJobPosting($id: String!) { jobPosting(id: $id) { title } }' })))
  assert.ok(graphqlRead(req([{ query: 'query A { a }' }, { query: '{ b }' }])))
  assert.ok(!graphqlRead(req({ query: 'mutation ApiSubmitApplication { submit }' })))
  assert.ok(!graphqlRead(req({ query: 'query A { a } mutation B { b }' })))
  assert.ok(!graphqlRead(req([{ query: 'query A { a }' }, { query: 'mutation B { b }' }])))
  assert.ok(!graphqlRead(req({ operationName: 'A', extensions: { persistedQuery: { sha256Hash: 'x' } } })), 'no query text: cannot tell')
  assert.ok(!graphqlRead(req({ query: 'query A { a }' }, 'text/plain')))
})

test('guard rules: normal dry runs write nothing; scoring runs may upload a résumé, never apply', async () => {
  const { decideRequest } = await import('../worker/lib/guard.mjs')
  const post = { method: 'POST', allowedHost: true }
  // Normal dry run: no write of any kind, not even to upload storage.
  assert.equal(decideRequest({ ...post, dryRun: true }).allow, false, 'application POST')
  assert.equal(decideRequest({ method: 'POST', allowedHost: false, upload: true, dryRun: true }).allow, false, 'résumé upload')
  assert.equal(decideRequest({ method: 'PUT', allowedHost: false, upload: true, dryRun: true, allowUploads: false }).allow, false)
  // Scoring run (dry run + allowUploads): only upload storage.
  assert.equal(decideRequest({ method: 'POST', allowedHost: false, upload: true, dryRun: true, allowUploads: true }).allow, true)
  assert.equal(decideRequest({ ...post, dryRun: true, allowUploads: true }).allow, false, 'the application itself is still blocked')
  assert.equal(decideRequest({ method: 'POST', allowedHost: false, dryRun: true, allowUploads: true }).allow, false)
  // GraphQL queries are reads (Ashby shows its form through them), only on allowed hosts.
  assert.equal(decideRequest({ ...post, graphqlRead: true, dryRun: true }).allow, true)
  assert.equal(decideRequest({ method: 'POST', allowedHost: false, graphqlRead: true, dryRun: true }).allow, false)
  // Normal (non-dry) runs: as before.
  assert.equal(decideRequest({ ...post, dryRun: false }).allow, true)
  assert.equal(decideRequest({ method: 'POST', allowedHost: false, upload: true, dryRun: false }).allow, true)
  assert.equal(decideRequest({ method: 'POST', allowedHost: false, dryRun: false }).allow, false)
  // Navigation only to allowed hosts; plain reads always.
  assert.equal(decideRequest({ method: 'GET', navigation: true, allowedHost: false }).allow, false)
  assert.equal(decideRequest({ method: 'GET', allowedHost: false }).allow, true)
})

test('re-drafting keeps your answers and skips, refreshes unanswered entries, keeps orphaned answers', async () => {
  const { mergeKey, todoGroups, fillFromAnswers } = await import('./lib.mjs')
  const existing = { entries: [
    { label: 'First Name* First Name', kind: 'text', expected: 'Jane', source: 'claude: profile fact' },
    { label: 'Degree*', kind: 'choice', expected: null, source: 'TODO' },
    { label: 'Pronouns', kind: 'radio', expected: null, skip: true },
    { label: 'English (ENG)', kind: 'check', expected: 'checked', source: 'claude: profile fact' },
    { label: 'Type your response', kind: 'text', expected: null },
  ] }
  const fresh = [
    { label: 'First Name', kind: 'text', expected: 'Aarav', source: 'profile' },
    { label: 'Degree', kind: 'choice', expected: null, options: ["Bachelor's", "Master's"], source: 'TODO' },
    { label: 'Pronouns', kind: 'radio', expected: null, source: 'TODO' },
    { label: 'Language Skill(s) (Check all that apply)', kind: 'checks', expected: null, options: ['English (ENG)', 'Hindi (HIN)'] },
    { label: 'Current CTC', kind: 'text', expected: null, required: true },
  ]
  const m = mergeKey(existing, fresh)
  assert.equal(m.entries[0].expected, 'Jane', 'your answer stays')
  assert.equal(m.entries[0].source, 'claude: profile fact')
  assert.deepEqual(m.entries[1].options, ["Bachelor's", "Master's"], 'unanswered entry refreshed')
  assert.equal(m.entries[2].skip, true, 'skip stays')
  assert.equal(m.kept, 2); assert.equal(m.refreshed, 1); assert.equal(m.added, 2)
  assert.deepEqual(m.orphans.map(o => o.label), ['English (ENG)'], 'an answered field that is gone is kept as an orphan')

  // Answer each question once across postings.
  const keys = [{ id: 1, entries: [{ label: 'Degree*', kind: 'choice', expected: null, required: true }, { label: 'Current CTC', kind: 'text', expected: null }] },
    { id: 7, entries: [{ label: 'Degree', kind: 'choice', expected: null }, { label: 'Notice Period', kind: 'text', expected: '30 days' }] }]
  const groups = todoGroups(keys)
  assert.deepEqual(groups.map(g => [g.question, g.postings]), [['Degree', [1, 7]], ['Current CTC', [1]]])
  assert.equal(fillFromAnswers(keys, [{ question: 'Degree', kind: 'choice', expected: "Bachelor's" }, { question: 'Notice Period', kind: 'text', expected: 'ignored' }]), 2)
  assert.equal(keys[0].entries[0].expected, "Bachelor's"); assert.equal(keys[1].entries[0].expected, "Bachelor's")
  assert.equal(keys[1].entries[1].expected, '30 days', 'never overwrites an answer')
})

test('résumé counts as attached when the uploader shows its name; missing fields name their nearest page labels', async () => {
  const { scorePage } = await import('./lib.mjs')
  const el = (label, extra = {}) => ({ tag: 'input', type: 'text', role: 'textbox', label, ...extra })
  const obs = { alerts: [], text: 'Resume/CV* Jane_Doe_Resume.pdf Remove', elements: [
    el('Resume/CV* Attach', { type: 'file', role: 'file', file: true, value: '' }),
    el('Current city of residence*', { role: 'combobox', value: 'Bengaluru', required: true }),
  ] }
  const key = { entries: [{ label: 'Location (City)*', kind: 'choice', required: true, expected: 'Bengaluru' }] }
  assert.equal(scorePage(obs, key, { resumeName: 'Jane_Doe_Resume.pdf' }).resume_ok, true)
  assert.equal(scorePage(obs, key, { resumeName: 'Other.pdf' }).resume_ok, false)
  const r = scorePage(obs, key)
  assert.deepEqual(r.wrong[0].near, ['Current city of residence'])
})

test('blocked writes in the summary name the GraphQL operation', async () => {
  const { report } = await import('./run.mjs')
  const writes = JSON.stringify([{ url: 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiCreateFileUpload', method: 'POST', allowed: false }])
  const md = report([{ posting_id: 12, platform: 'ashby', title: 'Ramp', attempt: 1, reached_submit: true, fields_correct: 5, fields_total: 5, resume_ok: false, questions: 0, steps: 9, seconds: 20, cost: 0.01, writes, wrongList: [], emptyRequired: [], blocked: 1, allowedWrites: 0 }], 'agent')
  assert.match(md, /POST jobs\.ashbyhq\.com\/api\/non-user-graphql\?op=ApiCreateFileUpload` ×1/)
})
