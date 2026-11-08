// Production worker: drains the queue one job at a time until it is empty or the time budget is spent.
// apply.yml runs at most one of these at once (concurrency group), so draining here is what makes sure
// jobs queued while a run is busy still get picked up.
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { runJob } from './lib/session.mjs'
import { notify } from './lib/telegram.mjs'

// Browser/model/human waits can outlive a database connection. Each query borrows a connection;
// an idle disconnect is removed by pg, while a failed in-flight query still rejects (never replayed).
export function createWorkerDb(connectionString, log = console.error) {
  const db = new pg.Pool({ connectionString, max: 1, idleTimeoutMillis: 30000, keepAlive: true })
  db.on('error', error => log(`Idle worker database connection lost: ${error.message}`))
  return db
}

export async function drain({ db, workerId = randomUUID(), budgetMs = Number(process.env.WORKER_BUDGET_MINUTES || 50) * 60000, run = runJob, log = console.log }) {
  const claim = await readFile(new URL('../db/claim_job.sql', import.meta.url), 'utf8')
  const started = Date.now()
  const results = []
  while (Date.now() - started < budgetMs) {
    const settings = Object.fromEntries((await db.query('SELECT key, value FROM settings')).rows.map(r => [r.key, r.value]))
    if (!await withinMonthlyBudget(db, settings, log)) break
    const job = (await db.query(claim, [workerId, '15 minutes'])).rows[0]
    if (!job) break
    const result = await run({ db, job, workerId, settings, resume: job.checkpoint || null })
    log(`${job.id} ${result.status}: ${result.note || ''}`)
    results.push({ id: job.id, ...result })
  }
  if (!results.length) log('No queued job')
  return results
}

// Estimated model spend this calendar month (from each job's recorded token counts).
export async function monthSpend(db) {
  const r = await db.query("SELECT COALESCE(sum((cost->>'cost')::numeric), 0)::float AS usd FROM jobs WHERE updated_at >= date_trunc('month', now()) AND cost IS NOT NULL").catch(() => ({ rows: [{ usd: 0 }] }))
  return r.rows[0].usd
}

// Alerts once at 80% of the monthly budget and stops claiming jobs at 100%. 0 means no cap.
export async function withinMonthlyBudget(db, settings, log = console.log, send = notify) {
  const cap = Number(settings.monthly_budget_usd) || 0
  if (cap <= 0) return true
  const spent = await monthSpend(db)
  const month = new Date().toISOString().slice(0, 7)
  const level = spent >= cap ? '100' : spent >= cap * 0.8 ? '80' : null
  if (level && settings.budget_alerted_month !== `${month}:${level}`) {
    await db.query("INSERT INTO settings (key, value) VALUES ('budget_alerted_month', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(`${month}:${level}`)])
    await send(level === '100'
      ? `Monthly model budget reached ($${spent.toFixed(2)} of $${cap}). New jobs wait until next month or until you raise the budget in Settings.`
      : `Heads up: $${spent.toFixed(2)} of your $${cap} monthly model budget is used.`)
  }
  if (spent >= cap) { log(`Monthly budget reached ($${spent.toFixed(2)} of $${cap}); not claiming jobs`); return false }
  return true
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createWorkerDb(process.env.DATABASE_URL)
  try {
    const results = await drain({ db })
    process.exitCode = results.some(r => r.status === 'failed') ? 1 : 0
  } finally {
    await db.end()
  }
}
