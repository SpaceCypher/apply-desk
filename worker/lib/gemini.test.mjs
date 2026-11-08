import test from 'node:test'
import assert from 'node:assert/strict'
import { createGeminiClient, geminiError } from './gemini-client.mjs'
import { hasRealModel, setModelBackend, generate, generateContent } from './gemini.mjs'
class AI { constructor(options) { this.options = options } }
test('API key takes precedence, without Vertex or ambient credentials', () => {
  assert.deepEqual(createGeminiClient({ GEMINI_API_KEY: 'fake-key', GOOGLE_CLOUD_PROJECT: 'ignored', GOOGLE_SERVICE_ACCOUNT_JSON: 'invalid' }, AI).options, { apiKey: 'fake-key' })
})
test('Vertex selection preserves project, default/explicit location and service account', () => {
  assert.deepEqual(createGeminiClient({ GOOGLE_CLOUD_PROJECT: 'test' }, AI).options, { vertexai: true, project: 'test', location: 'global' })
  const credentials = { client_email: 'test@example.com', private_key: 'test-only' }
  assert.deepEqual(createGeminiClient({ GOOGLE_CLOUD_PROJECT: 'test', GOOGLE_CLOUD_LOCATION: 'us-central1', GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(credentials) }, AI).options,
    { vertexai: true, project: 'test', location: 'us-central1', googleAuthOptions: { credentials, scopes: ['https://www.googleapis.com/auth/cloud-platform'] } })
  assert.throws(() => createGeminiClient({}, AI), /GEMINI_API_KEY.*GOOGLE_CLOUD_PROJECT/)
})
test('live-model detection supports either credential path and respects scripted backends', async () => {
  const saved = { key: process.env.GEMINI_API_KEY, project: process.env.GOOGLE_CLOUD_PROJECT }
  try {
    delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_CLOUD_PROJECT
    assert.equal(hasRealModel(), false)
    process.env.GEMINI_API_KEY = 'fake-key'; assert.equal(hasRealModel(), true)
    delete process.env.GEMINI_API_KEY; process.env.GOOGLE_CLOUD_PROJECT = 'test'; assert.equal(hasRealModel(), true)
    setModelBackend(async () => '{}'); assert.equal(hasRealModel(), false)
  } finally {
    setModelBackend(null)
    for (const [name, value] of [['GEMINI_API_KEY', saved.key], ['GOOGLE_CLOUD_PROJECT', saved.project]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  }
})
test('API-key model errors name configuration and never leak the key or switch models', async () => {
  const saved = process.env.GEMINI_API_KEY
  const calls = []
  try {
    process.env.GEMINI_API_KEY = 'fake-key'
    setModelBackend(async options => { calls.push(options.model); throw Object.assign(new Error('model not found fake-key'), { status: 404 }) })
    for (const call of [() => generate({ prompt: 'test', model: 'requested-model' }), () => generateContent({ contents: 'test', model: 'requested-model' })]) {
      await assert.rejects(call(), error => /GEMINI_MODEL.*GEMINI_STRONG_MODEL/.test(error.message) && !error.message.includes('fake-key'))
    }
    assert.deepEqual(calls, ['requested-model', 'requested-model'])
    assert.match(geminiError({ status: 404 }, 'embed-model', 'GEMINI_EMBED_MODEL').message, /GEMINI_EMBED_MODEL/)
    assert.ok(!geminiError({ status: 403, message: 'URL?key=fake-key' }, 'test').message.includes('fake-key'))
  } finally { setModelBackend(null); if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved }
})
