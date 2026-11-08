import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleResume, masterFits, resumeHtml, writeCoverLetter, wordCount } from './documents.mjs'
import { verifySupported } from './facts.mjs'

const profile = {
  first_name: 'A', last_name: 'B', email: 'a@example.com',
  skills: [{ name: 'Node.js' }, { name: 'PostgreSQL' }, { name: 'React' }],
  experiences: [
    { id: 'e1', company: 'Acme', title: 'Intern', bullets: ['Built a REST API with Node.js serving 2k users', 'Wrote React dashboards'] },
    { id: 'e2', company: 'Beta', title: 'Intern', bullets: ['Tuned PostgreSQL queries'] },
  ],
  projects: [{ id: 'p1', name: 'One', short: 'x' }, { id: 'p2', name: 'Two', short: 'y' }],
}

test('assembleResume keeps supported rewrites and reverts invented ones', () => {
  const plan = {
    experience_order: ['e2', 'e1'],
    bullets: { e1: [
      { source_index: 0, text: 'Built a REST API in Node.js for 2k users' },
      { source_index: 1, text: 'Wrote React dashboards using Kubernetes' },
    ] },
    projects: ['p2'], skills: ['React', 'Rust'],
  }
  const r = assembleResume(profile, plan)
  assert.equal(r.experiences[0].id, 'e2')
  assert.equal(r.experiences[1].bullets[0], 'Built a REST API in Node.js for 2k users')
  assert.equal(r.experiences[1].bullets[1], 'Wrote React dashboards')
  assert.equal(r.projects[0].id, 'p2')
  assert.deepEqual(r.skills, ['React', 'Node.js', 'PostgreSQL'])
})

test('an LLM verdict of unsupported reverts the rewrite', () => {
  const plan = { bullets: { e1: [{ source_index: 0, text: 'Built a REST API in Node.js for 2k users' }] } }
  assert.equal(assembleResume(profile, plan, { 'e1:0': false }).experiences[0].bullets[0], 'Built a REST API with Node.js serving 2k users')
})

test('masterFits and html escaping', () => {
  assert.ok(masterFits({ must_have: ['node.js', 'react'] }, profile))
  assert.ok(!masterFits({ must_have: ['go', 'rust', 'kubernetes'] }, profile))
  const html = resumeHtml({ ...profile, first_name: '<b>x' }, assembleResume(profile, {}))
  assert.ok(!html.includes('<b>x'))
})

test('cover letter retries until length and facts pass', async () => {
  const good = ('I enjoy building Node.js services. ').repeat(50)
  let calls = 0
  const gen = async () => (++calls === 1 ? 'Too short.' : good)
  const letter = await writeCoverLetter(profile, { company: 'Gamma', title: 'Engineer', keywords: [] }, 'jd', { generateFn: gen })
  assert.equal(calls, 2)
  assert.ok(wordCount(letter) >= 250)
  const bad = async () => ('I led Kubernetes migrations at Initech. ').repeat(60)
  await assert.rejects(writeCoverLetter(profile, { company: 'Gamma', title: 'Engineer', keywords: [] }, 'jd', { generateFn: bad }))
})

test('sentence-initial words are not treated as claims', () => {
  assert.ok(verifySupported('Built things. Shipped them.', 'x').ok)
})
