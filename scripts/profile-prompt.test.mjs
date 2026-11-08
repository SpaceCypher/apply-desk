import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { cleanProfile } from '../src/lib/profile.ts'

test('documented Profile import example survives the real normalizer unchanged', async () => {
  const prompt = await readFile(new URL('../docs/profile-prompt.md', import.meta.url), 'utf8')
  const blocks = [...prompt.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  assert.equal(blocks.length, 1, 'one unambiguous import example')
  const example = JSON.parse(blocks[0][1])
  assert.deepEqual(Object.keys(example).sort(), ['answers', 'fields'])
  assert.deepEqual(cleanProfile(example.fields), example.fields)
  assert.ok(Array.isArray(example.answers))
  for (const item of example.answers) {
    assert.deepEqual(Object.keys(item).sort(), ['answer', 'question'])
    assert.ok(typeof item.question === 'string' && item.question.trim() && item.question.length <= 500)
    assert.ok(typeof item.answer === 'string' && item.answer.trim() && item.answer.length <= 2000)
  }
})
