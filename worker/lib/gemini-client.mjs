import { GoogleGenAI } from '@google/genai'

// Shared by the worker and setup so the validated credentials match runtime selection.
export function createGeminiClient(env = process.env, AI = GoogleGenAI) {
  if (env.GEMINI_API_KEY) return new AI({ apiKey: env.GEMINI_API_KEY })
  if (!env.GOOGLE_CLOUD_PROJECT) throw new Error('Set GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT for Vertex AI')
  const keyJson = env.GOOGLE_SERVICE_ACCOUNT_JSON
  return new AI({
    vertexai: true,
    project: env.GOOGLE_CLOUD_PROJECT,
    location: env.GOOGLE_CLOUD_LOCATION || 'global',
    ...(keyJson && { googleAuthOptions: { credentials: JSON.parse(keyJson), scopes: ['https://www.googleapis.com/auth/cloud-platform'] } }),
  })
}

export function geminiError(error, model, setting = 'GEMINI_MODEL or GEMINI_STRONG_MODEL', env = process.env) {
  if (!env.GEMINI_API_KEY) return new Error(`Gemini error ${error.status ?? ''} ${error.message}`.trim())
  if (error.status === 404 || /model.*(?:not found|not supported|not available|unavailable)|not supported for (?:generateContent|embedContent)/i.test(error.message || '')) {
    return new Error(`Gemini model "${model}" is unavailable with GEMINI_API_KEY. Set ${setting} to a model available to your API key; no model was changed.`)
  }
  // SDK messages may contain request URLs, including the key. Keep these out of logs.
  return new Error(`Gemini API error ${error.status ?? ''}: check GEMINI_API_KEY, billing, quotas and model configuration.`)
}
