import test from 'node:test'
import assert from 'node:assert/strict'
import { validateServices, setWebhook, dotenv } from './setup-validators.mjs'
const env = { DATABASE_URL: 'postgresql://test@localhost/test', GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', client_email: 'test@example.com', private_key: 'test-only' }), GOOGLE_CLOUD_PROJECT: 'test', GOOGLE_CLOUD_LOCATION: 'global', GEMINI_MODEL: 'test', TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_CHAT_ID: '1', GH_REPOSITORY: 'example/repo', GH_REF: 'main', AUTH_URL: 'https://example.vercel.app', TELEGRAM_WEBHOOK_SECRET: 'fake' }
function mocks(fail) {
  const calls = []
  class Client { async connect() { calls.push('db'); if (fail === 'db') throw Error() } async query() {} async end() { calls.push('end') } }
  class AI { constructor(options) { calls.push({ ai: options }) } models = { generateContent: async () => ({ text: fail === 'ai' ? '' : 'OK' }) } }
  class Imap { async connect() { calls.push('imap'); if (fail === 'imap') throw Error() } close() { calls.push('close') } }
  const request = async (url, options) => { calls.push([url, JSON.parse(options.body)]); return { status: fail === 'github' ? 403 : 204, ok: true, json: async () => ({ ok: fail !== 'telegram' }) } }
  return { Client, AI, Imap, request, calls }
}
test('validates every service; dispatches only harmless setup check', async () => {
  const m = mocks(); await validateServices(env, m)
  assert.ok(m.calls.includes('db')); assert.ok(m.calls.includes('end')); assert.ok(m.calls.includes('imap')); assert.ok(m.calls.includes('close'))
  assert.ok(m.calls.some(c => Array.isArray(c) && c[0].endsWith('/getMe')))
  assert.ok(m.calls.some(c => Array.isArray(c) && c[0].endsWith('/setup-check.yml/dispatches') && c[1].ref === 'main'))
})
for (const failure of ['db', 'ai', 'telegram', 'imap', 'github']) test(`rejects failed ${failure} validation`, async () => { await assert.rejects(validateServices(env, mocks(failure))) })
test('webhook rejects unsafe origins and API failures', async () => {
  await assert.rejects(setWebhook({ ...env, AUTH_URL: 'http://example.com' }))
  await assert.rejects(setWebhook(env, async () => ({ ok: false })))
  let body
  await setWebhook(env, async (_, o) => { body = JSON.parse(o.body); return { ok: true, json: async () => ({ ok: true }) } })
  assert.deepEqual(body, { url: 'https://example.vercel.app/api/telegram', secret_token: 'fake' })
})
test('dotenv preserves JSON and escapes Next.js interpolation', () => {
  const out = dotenv({ A: '{"private_key":"line\\n"}', B: '$HOME`id`' })
  assert.ok(out.includes("B='\\$HOME`id`'"))
  assert.ok(out.includes('line\\n'))
})
test('generated env values round-trip through the Next.js loader', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createRequire } = await import('node:module')
  const { execFileSync } = await import('node:child_process')
  const require = createRequire(import.meta.url)
  const dir = await mkdtemp(join(tmpdir(), 'setup-env-test-'))
  const values = { SETUP_TEST_A: '$HOME`id`\\path', SETUP_TEST_B: '{"private_key":"line\\nnext"}', SETUP_TEST_C: "quote'and$dollar" }
  try {
    await writeFile(join(dir, '.env.local'), dotenv(values))
    const result = execFileSync(process.execPath, ['-e', 'const loader=require(process.argv[1]); const result=loader.loadEnvConfig(process.argv[2], false, {info(){},error(){}}); console.log(JSON.stringify(result.parsedEnv))', require.resolve('@next/env'), dir], { encoding: 'utf8', env: {} })
    assert.deepEqual(JSON.parse(result), values)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('missing service-account credentials never fall back to ambient auth', async () => {
  await assert.rejects(validateServices({ ...env, GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }, mocks()), /Service-account JSON required/)
})
test('setup validates API keys without requiring or parsing Vertex credentials', async () => {
  const m = mocks()
  await validateServices({ ...env, GEMINI_API_KEY: 'fake-key', GOOGLE_SERVICE_ACCOUNT_JSON: 'invalid', GOOGLE_CLOUD_PROJECT: '' }, m)
  assert.deepEqual(m.calls.find(c => c.ai).ai, { apiKey: 'fake-key' })
  await assert.rejects(validateServices({ ...env, GEMINI_API_KEY: 'fake-key', GOOGLE_SERVICE_ACCOUNT_JSON: '' }, mocks('ai')), /Gemini returned no text/)
})
