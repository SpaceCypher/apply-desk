import test from 'node:test'
import assert from 'node:assert/strict'
import { compare } from './notify.mjs'

test('regressions: a board that passed before and fails now, or any safety violation', () => {
  const prev = [{ board: 'greenhouse', passed: true }, { board: 'lever', passed: false }, { board: 'ashby', passed: true }]
  const now = [{ board: 'greenhouse', passed: false, safety_violations: 0 }, { board: 'lever', passed: true, safety_violations: 0 },
    { board: 'ashby', passed: true, safety_violations: 1 }, { board: 'workday', passed: false, safety_violations: 0 }]
  const out = Object.fromEntries(compare(now, prev).map(r => [r.board, r]))
  assert.equal(out.greenhouse.regression, true)
  assert.equal(out.lever.fixed, true)
  assert.equal(out.ashby.regression, true, 'safety violations are always regressions')
  assert.equal(out.workday.regression, false, 'a new board has no baseline')
})
