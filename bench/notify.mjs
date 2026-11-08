// Bench summary: compares this run with the previous run per board, writes a GitHub step summary, and posts
// to Telegram. A board that passed last time and fails now, or any safety violation, is called out as a regression.
import { appendFile } from 'node:fs/promises'
import pg from 'pg'

export function compare(rows, previous) {
  const prevBy = new Map(previous.map(r => [r.board, r]))
  return rows.map(r => {
    const p = prevBy.get(r.board)
    const regression = Number(r.safety_violations) > 0 || (!!p?.passed && !r.passed)
    return { ...r, prev: p || null, regression, fixed: !!p && !p.passed && !!r.passed }
  })
}

export async function notifySummary({ db, rows, runId = rows?.[0]?.run_id }) {
  if (!rows?.length && runId) rows = (await db.query('SELECT * FROM bench_runs WHERE run_id=$1 ORDER BY board', [runId])).rows
  if (!rows?.length) return null
  const previous = (await db.query('SELECT DISTINCT ON (board) * FROM bench_runs WHERE run_id <> $1 AND board = ANY($2) ORDER BY board, created_at DESC', [runId, rows.map(r => r.board)])).rows
  const out = compare(rows, previous)
  const passed = out.filter(r => r.passed).length
  const calls = out.reduce((n, r) => n + Number(r.model_calls), 0)
  const cost = out.reduce((n, r) => n + Number(r.est_cost), 0)
  const regressions = out.filter(r => r.regression)
  const lines = out.map(r => `${r.passed ? '✅' : '❌'} ${r.board}: ${r.stage}${r.regression ? ' (regression)' : r.fixed ? ' (fixed)' : ''}`)
  const text = `Bench ${runId}: ${passed}/${out.length} passed, ${calls} model calls, ~$${cost.toFixed(3)}\n${regressions.length ? `⚠️ ${regressions.length} regression(s): ${regressions.map(r => r.board).join(', ')}\n` : ''}${lines.join('\n')}`
  if (process.env.GITHUB_STEP_SUMMARY) {
    const table = ['| Board | Result | Stage | Calls | Asks | Recoveries | Note |', '|---|---|---|---|---|---|---|',
      ...out.map(r => `| ${r.board} | ${r.passed ? 'pass' : 'FAIL'}${r.regression ? ' (regression)' : ''} | ${r.stage} | ${r.model_calls} | ${r.questions} | ${r.recoveries} | ${String(r.note || '').replace(/\|/g, '/').slice(0, 120)} |`)]
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Bench\n\n${passed}/${out.length} passed, ${calls} model calls, ~$${cost.toFixed(3)}\n\n${table.join('\n')}\n`)
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: text.slice(0, 4000) }),
    }).catch(() => {})
  }
  return { text, regressions }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new pg.Client({ connectionString: process.env.BENCH_RESULTS_URL || process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await notifySummary({ db, rows: [], runId: process.env.GITHUB_RUN_ID || process.argv[2] })
    console.log(r?.text || 'No bench rows for this run')
    process.exitCode = r?.regressions?.length ? 1 : 0
  } finally { await db.end() }
}
