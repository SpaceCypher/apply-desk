import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile, access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { validateServices, setWebhook, dotenv } from './setup-validators.mjs'

class SetupError extends Error {}

let hidden = false
const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk); done() } })
let stage = "input validation"
const rl = createInterface({ input: process.stdin, output, terminal: true })
const secret = /SECRET|TOKEN|PASSWORD|PIN|KEY|SERVICE_ACCOUNT_JSON/
async function ask(label, sensitive = false) {
  process.stdout.write(`${label}: `)
  hidden = sensitive
  try { return (await rl.question('')).trim() } finally { hidden = false; process.stdout.write('\n') }
}
const github = ['DATABASE_URL', 'VAULT_KEY', 'GEMINI_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GEMINI_MODEL', 'GEMINI_STRONG_MODEL', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'JOB_GMAIL_ADDRESS', 'JOB_GMAIL_APP_PASSWORD', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']
try {
  if (!process.stdin.isTTY) throw new SetupError('Run setup interactively in a terminal')
  try { await access('.env.local'); throw new SetupError('Existing .env.local: preserve your vault key; refusing overwrite') } catch (e) { if (e.code !== 'ENOENT') throw e }
  console.log('Use NEW self-host resources only. No inherited environment credentials are used. Service validation includes a tiny billed Gemini call and a harmless setup-check workflow dispatch.')
  console.log('For AI Studio keys, enable billing before using resume/PII; free-tier prompts may be used to improve Google products.')
  let provider
  do { provider = (await ask('Gemini API key (easiest) or Vertex AI? Type api-key or vertex [api-key]')).toLowerCase() || 'api-key' } while (!['api-key', 'vertex'].includes(provider))
  const env = {}
  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8')
  for (const line of template.split('\n')) {
    const match = line.match(/^([A-Z_0-9]+)=(.*)$/)
    if (!match) continue
    const [, key, fallback] = match
    if (key.startsWith('GOOGLE_') && provider === 'api-key') continue
    if (key === 'GEMINI_API_KEY' && provider === 'vertex') continue
    if (key === 'VAULT_KEY') { env[key] = randomBytes(32).toString('base64'); continue }
    if (key === 'AUTH_SECRET' || key === 'TELEGRAM_WEBHOOK_SECRET') { env[key] = randomBytes(32).toString('hex'); continue }
    const optional = key.startsWith('R2_')
    let value
    do { value = await ask(`${key}${optional ? ' (optional)' : ''}${fallback && key !== 'GH_REPOSITORY' ? ` [${fallback}]` : ''}`, secret.test(key) || key === 'DATABASE_URL') || (key !== 'GH_REPOSITORY' ? fallback : '') } while (!optional && !value)
    env[key] = value
  }
  if (!/^\d+$/.test(env.ALLOWED_GITHUB_ID) || env.VAULT_REVEAL_PIN.length < 6 || !/^[\w.-]+\/[\w.-]+$/.test(env.GH_REPOSITORY)) throw new SetupError('Check numeric GitHub ID, reveal PIN (6+ characters), and owner/repository')
  const origin = new URL(env.AUTH_URL)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new SetupError('AUTH_URL must be an HTTPS origin')
  if (Object.keys(env).filter(k => k.startsWith('R2_')).some(k => env[k]) && Object.keys(env).filter(k => k.startsWith('R2_')).some(k => !env[k])) throw new SetupError('Supply all R2 values or leave all empty')
  stage = 'service validation (Postgres, Gemini, Telegram, Gmail, GitHub dispatch)'
  console.log('Validating services…')
  await validateServices(env, { onStage: name => { stage = name; console.log(`Checking ${name}…`) } })
  console.log('Service checks passed. OAuth client credentials, optional R2 and strong model are not live-validated; verify sign-in and storage after deployment.')
  if ((await ask('Type yes to migrate this database and register the Telegram webhook')).toLowerCase() !== 'yes') throw new SetupError('Cancelled before migrations and webhook')
  // Save the generated key before any side effects; never lose an installed vault key.
  await writeFile('.env.local', dotenv(env), { mode: 0o600, flag: 'wx' })
  stage = 'database migrations (credentials retained in .env.local)'
  const migration = spawnSync(process.execPath, ['scripts/migrate.mjs'], { env: { ...process.env, ...env }, stdio: 'pipe' })
  if (migration.status !== 0) throw new SetupError('Migrations failed; credentials saved privately in .env.local. Inspect the database before retrying')
  stage = 'Telegram webhook registration (credentials retained in .env.local)'
  await setWebhook(env)
  const names = github.filter(k => env[k])
  console.log(`GitHub Actions secrets:\n${names.join('\n')}\n\nVercel environment variables:\n${Object.keys(env).filter(k => env[k]).join('\n')}\n\nCopy values privately from .env.local; never commit this file. Redeploy Vercel. Review mode is the default; Auto is off.`)
  if (spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0 && (await ask('Upload these GitHub secrets with gh? Type yes')).toLowerCase() === 'yes') {
    for (const key of names) {
      if (spawnSync('gh', ['secret', 'set', key, '--repo', env.GH_REPOSITORY], { input: env[key], stdio: ['pipe', 'ignore', 'ignore'] }).status !== 0) throw new SetupError(`Could not upload ${key}; local file retained`)
    }
    console.log('GitHub secrets uploaded.')
  }
} catch (error) {
  // Third-party exceptions can contain connection strings or tokens. Never echo them.
  console.error(`Setup stopped during ${stage}. ${error instanceof SetupError ? error.message : "Check inputs and permissions."} Secret values are hidden; existing .env.local is never overwritten.`)
  process.exitCode = 1
} finally { rl.close() }
