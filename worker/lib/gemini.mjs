// Gemini via an AI Studio API key, or Vertex AI when no key is configured.
import { createGeminiClient, geminiError } from './gemini-client.mjs'

export const FLASH = () => process.env.GEMINI_MODEL || 'gemini-3.5-flash'
export const STRONG = () => process.env.GEMINI_STRONG_MODEL || 'gemini-3.1-pro-preview'

let ai
function client() {
  if (!ai) ai = createGeminiClient()
  return ai
}

export function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(cleaned)
}

// Tests and the bench install a scripted backend here instead of calling Vertex.
// A backend receives the same options and returns { text, usage? }.
let backend = null
export function setModelBackend(fn) { backend = fn }

// Prices in USD per million tokens, for cost estimates only. Override with GEMINI_PRICES='{"model":[in,out]}'.
const PRICES = { flash: [0.3, 2.5], pro: [1.25, 10] }
export function estimateCost(model, tokensIn, tokensOut) {
  let custom = {}
  try { custom = JSON.parse(process.env.GEMINI_PRICES || '{}') } catch { /* ignore */ }
  const [pin, pout] = custom[model] || (/pro/i.test(model) ? PRICES.pro : PRICES.flash)
  return (tokensIn * pin + tokensOut * pout) / 1e6
}

// meter (optional): { add(model, tokensIn, tokensOut) } — the run context passes one so every call is counted.
export async function generate({ system, prompt, image, json = true, model = FLASH(), temperature = 0.2, meter, kind = 'step', sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const parts = [{ text: prompt }]
  if (image) parts.push({ inlineData: { mimeType: 'image/png', data: image.toString('base64') } })
  const config = { temperature, ...(json ? { responseMimeType: 'application/json' } : {}), ...(system ? { systemInstruction: system } : {}) }
  for (let attempt = 0; ; attempt++) {
    let text, usage
    try {
      if (backend) {
        const r = await backend({ system, prompt, image, json, model, kind })
        text = typeof r === 'string' ? r : r.text ?? JSON.stringify(r.data)
        usage = r.usage
      } else {
        const response = await client().models.generateContent({ model, contents: [{ role: 'user', parts }], config })
        text = response.text || ''
        const u = response.usageMetadata || {}
        usage = { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) }
      }
    } catch (error) {
      if ((error.status === 429 || error.status >= 500) && attempt < 5) {
        await sleep(Math.min(60000, 2000 * 2 ** attempt))
        continue
      }
      throw geminiError(error, model)
    }
    meter?.add(model, usage?.in || Math.ceil(prompt.length / 4), usage?.out || Math.ceil((text || '').length / 4), kind)
    if (!text) throw new Error('Gemini returned no text')
    return json ? parseJson(text) : text
  }
}

// A raw call for engines that bring their own prompts (Stagehand): `contents` and `config` in @google/genai form.
// Same retries, metering and scripted backend as generate(). Returns { text, functionCalls, usage }.
export async function generateContent({ model = FLASH(), contents, config = {}, meter, kind = 'engine', sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  for (let attempt = 0; ; attempt++) {
    let out
    try {
      if (backend) {
        const r = await backend({ raw: true, model, contents, config, kind })
        out = { text: r.text || '', functionCalls: r.functionCalls || [], usage: r.usage || { in: 0, out: 0 } }
      } else {
        const response = await client().models.generateContent({ model, contents, config })
        const u = response.usageMetadata || {}
        out = { text: response.text || '', functionCalls: response.functionCalls || [], usage: { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } }
      }
    } catch (error) {
      if ((error.status === 429 || error.status >= 500) && attempt < 5) {
        await sleep(Math.min(60000, 2000 * 2 ** attempt))
        continue
      }
      throw geminiError(error, model)
    }
    meter?.add(model, out.usage.in, out.usage.out, kind)
    return out
  }
}

// True when calls use either live provider (not a scripted backend in tests or the bench).
export const hasRealModel = () => !backend && !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_PROJECT)

// Embeddings for a batch of texts (same provider as generation). Tests can install embedBackend instead.
let embedBackend = null
export function setEmbedBackend(fn) { embedBackend = fn }
export async function embed(texts, model) {
  if (embedBackend) return embedBackend(texts, model)
  try {
    const r = await client().models.embedContent({ model, contents: texts })
    return (r.embeddings || []).map(e => e.values)
  } catch (error) {
    if (process.env.GEMINI_API_KEY) throw geminiError(error, model, 'GEMINI_EMBED_MODEL')
    throw error
  }
}
