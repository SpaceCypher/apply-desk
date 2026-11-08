import pg from 'pg'
import { GoogleGenAI } from '@google/genai'
import { ImapFlow } from 'imapflow'
import { createGeminiClient, geminiError } from '../worker/lib/gemini-client.mjs'

export async function validateServices(env, { Client = pg.Client, AI = GoogleGenAI, Imap = ImapFlow, request = fetch, onStage = () => {} } = {}) {
  onStage('Postgres connection')
  const db = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10000 })
  try { await db.connect(); await db.query('SELECT 1') } finally { await db.end() }
  onStage(env.GEMINI_API_KEY ? 'Gemini API key call (GEMINI_API_KEY / GEMINI_MODEL)' : 'Vertex AI call')
  if (!env.GEMINI_API_KEY) {
    const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
    if (credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key) throw new Error('Service-account JSON required')
  }
  const ai = createGeminiClient(env, AI)
  let result
  try {
    result = await ai.models.generateContent({ model: env.GEMINI_MODEL, contents: 'Reply OK', config: { maxOutputTokens: 128 } })
  } catch (error) { throw geminiError(error, env.GEMINI_MODEL, 'GEMINI_MODEL', env) }
  if (!result.text?.trim()) throw new Error('Gemini returned no text')
  const telegram = async (method, body) => {
    const r = await request(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    })
    const data = await r.json()
    if (!r.ok || !data.ok) throw new Error('Telegram validation failed')
    return data
  }
  onStage('Telegram bot and chat access')
  await telegram('getMe', {})
  await telegram('getChat', { chat_id: env.TELEGRAM_CHAT_ID })
  onStage('Gmail IMAP login')
  const imap = new Imap({ host: 'imap.gmail.com', port: 993, secure: true, logger: false,
    connectionTimeout: 15000, auth: { user: env.JOB_GMAIL_ADDRESS, pass: env.JOB_GMAIL_APP_PASSWORD } })
  try { await imap.connect() } finally { imap.close() }
  onStage('GitHub setup-check dispatch')
  const r = await request(`https://api.github.com/repos/${env.GH_REPOSITORY}/actions/workflows/setup-check.yml/dispatches`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ ref: env.GH_REF }), signal: AbortSignal.timeout(15000),
  })
  if (r.status !== 204) throw new Error('GitHub dispatch failed; check token Actions write permission, repository, ref and setup-check.yml')
}

export async function setWebhook(env, request = fetch) {
  const url = new URL(env.AUTH_URL)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an HTTPS deployment origin')
  const r = await request(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ url: `${url.origin}/api/telegram`, secret_token: env.TELEGRAM_WEBHOOK_SECRET }),
  })
  if (!r.ok || !(await r.json()).ok) throw new Error('Webhook registration failed')
}

export function dotenv(env) {
  return Object.entries(env).map(([key, value]) => {
    const text = String(value)
    const quote = ["'", '`'].find(q => !text.includes(q))
    if (!quote) throw new Error('Value contains unsupported quote combination')
    return `${key}=${quote}${text.replaceAll('$', '\\$')}${quote}`
  }).join('\n') + '\n'
}
