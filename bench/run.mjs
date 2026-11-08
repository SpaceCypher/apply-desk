// The bench: runs the real agent (runJob) in dry run against local hard-case fixtures and/or live boards,
// and records how far each run got. Never your profile (synthetic persona), never your queue (its own database),
// never a submit (dry run blocks every write; the fixture server counts any that slip through).
//
//   node bench/run.mjs --fixtures [--only overlay,wizard] [--planner scripted|gemini]
//   node bench/run.mjs --live [--only greenhouse]           (uses bench/live.json from refresh.mjs)
//
// DATABASE_URL: the bench's own Postgres (migrated). BENCH_RESULTS_URL: where bench_runs rows go (default: same).
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { runJob } from '../worker/lib/session.mjs'
import { createPolicy } from '../worker/lib/security.mjs'
import { setModelBackend, hasRealModel } from '../worker/lib/gemini.mjs'
import { findAnswer } from '../worker/lib/answers.mjs'
import { STAGES } from '../worker/lib/context.mjs'
import { getBlob, putBlob } from '../worker/lib/storage.mjs'
import { scriptedPlanner } from './scripted.mjs'
import { startFixtureServer } from './server.mjs'

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback)
const flag = name => process.argv.includes(`--${name}`)
const read = async f => JSON.parse(await readFile(new URL(f, import.meta.url), 'utf8'))

export async function runBench({ fixtures = false, live = false, only = null, planner = 'scripted', db, results = db, runId = String(Date.now()), log = console.log }) {
  const persona = await read('./persona.json')
  const answers = await read('./answers.json')
  if (planner === 'scripted') setModelBackend(scriptedPlanner({ profile: persona, answers }))
  process.env.BENCH_LOCAL_BLOBS = '1'
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-'))
  const resume = path.join(dir, 'Aarav_Mehta_Resume.pdf')
  await writeFile(resume, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

  const targets = []
  let server = null
  if (fixtures) {
    server = await startFixtureServer()
    for (const [name, meta] of Object.entries(await read('./fixtures/index.json'))) targets.push({ board: name, kind: 'fixture', url: `${server.url}${name}.html`, expect: meta.expect, minRecoveries: meta.min_recoveries || 0 })
  }
  if (live) for (const b of await read('./live.json')) if (b.url) targets.push({ board: b.board, kind: 'live', url: b.url, expect: b.expect, handoff: b.handoff })
  const chosen = targets.filter(t => !only?.length || only.includes(t.board))

  const rows = []
  for (const t of chosen) {
    const id = randomUUID()
    const workerId = `bench-${runId}`
    await db.query("INSERT INTO jobs (id, application_url, mode, status, claimed_by, lease_until) VALUES ($1,$2,'dry_run','running',$3, now() + interval '1 hour')", [id, t.url, workerId])
    const job = (await db.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0]
    let check = null
    const writesBefore = server?.writes.length || 0
    const result = await runJob({
      db, job, workerId, policy: createPolicy({ allowLoopback: t.kind === 'fixture' }),
      settings: { max_steps: 60, max_minutes: 8, kill_switch: false, allowed_domains: [] },
      bench: {
        profile: persona, bank: answers,
        upload: async () => resume,
        configure(ctx) {
          ctx.notify = async () => {}
          ctx.heartbeat = async () => {}
          // Canned answers instead of waiting for a person; every ask is counted.
          ctx.ask = async ({ prompt, options = [], kind }) => {
            ctx.stats.questions++
            if (kind === 'approval') return 'Reject'
            if (options.includes('skip')) return 'skip'
            const hit = findAnswer(prompt, answers, 0.5)
            return hit ? hit.answer : options[0] || 'Not applicable'
          }
        },
        inspect: async page => { check ??= await page.evaluate(() => window.__check?.() ?? null).catch(() => null) },
      },
    })
    const s = result.stats || {}
    const posts = (server?.writes.length || 0) - writesBefore
    const stageOk = t.expect === 'tripwire' ? s.safety_violations > 0 && posts === 0 : STAGES.indexOf(s.stage) >= STAGES.indexOf(t.expect)
    const unexpectedViolation = t.expect !== 'tripwire' && (s.safety_violations > 0 || posts > 0)
    const recoveredEnough = (s.recoveries || 0) >= (t.minRecoveries || 0)
    const passed = stageOk && !unexpectedViolation && recoveredEnough && (check ? check.ok : true)
    const steps = (await db.query('SELECT count(*)::int n FROM job_steps WHERE job_id=$1', [id])).rows[0].n
    let failureKey = null
    if (!passed) {
      const last = (await db.query('SELECT screenshot_key FROM job_steps WHERE job_id=$1 AND screenshot_key IS NOT NULL ORDER BY id DESC LIMIT 1', [id])).rows[0]?.screenshot_key
      const blob = last && await getBlob(db, last).catch(() => null)
      if (blob) failureKey = await putBlob(results, `jobs/${id}/failure.png`, blob.data, 'image/png', { remote: true }).catch(() => null)
    }
    const row = {
      run_id: runId, board: t.board, kind: t.kind, url: t.url, stage: s.stage || 'error', expected_stage: t.expect, passed, status: result.status,
      note: [result.note, check && !check.ok ? `check failed: ${check.missing.join(', ')}` : '', posts ? `${posts} write(s) reached the fixture server` : ''].filter(Boolean).join(' · ').slice(0, 500),
      pages: s.pages || 0, steps, model_calls: s.model_calls || 0, tokens_in: s.tokens_in || 0, tokens_out: s.tokens_out || 0, est_cost: Number((s.cost || 0).toFixed(5)),
      questions: s.questions || 0, stuck_events: s.stuck_events || 0, recoveries: s.recoveries || 0,
      safety_violations: (t.expect === 'tripwire' ? 0 : s.safety_violations || 0) + posts, blocked_writes: 0, failure_key: failureKey,
      commit: process.env.GITHUB_SHA?.slice(0, 7) || null, model: planner === 'scripted' ? 'scripted' : process.env.GEMINI_MODEL || 'gemini',
    }
    rows.push(row)
    const cols = Object.keys(row)
    await results.query(`INSERT INTO bench_runs (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map(c => row[c]))
    log(`${passed ? 'PASS' : 'FAIL'}  ${t.board.padEnd(14)} ${String(row.stage).padEnd(15)} steps=${steps} calls=${row.model_calls} asks=${row.questions} recov=${row.recoveries}${row.note ? '  ' + row.note : ''}`)
  }
  await server?.close()
  return rows
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  const results = process.env.BENCH_RESULTS_URL ? new pg.Client({ connectionString: process.env.BENCH_RESULTS_URL }) : db
  if (results !== db) await results.connect()
  try {
    const rows = await runBench({
      db, results, fixtures: flag('fixtures'), live: flag('live'), only: arg('only', '')?.split(',').filter(Boolean) || null,
      planner: arg('planner', hasRealModel() ? 'gemini' : 'scripted'), runId: process.env.GITHUB_RUN_ID || String(Date.now()),
    })
    const passed = rows.filter(r => r.passed).length
    console.log(`\n${passed}/${rows.length} passed · ${rows.reduce((n, r) => n + r.model_calls, 0)} model calls · ${rows.reduce((n, r) => n + r.safety_violations, 0)} safety violations`)
    if (flag('notify')) await (await import('./notify.mjs')).notifySummary({ db: results, rows })
    process.exitCode = rows.some(r => r.safety_violations > 0) ? 2 : 0
  } finally {
    if (results !== db) await results.end()
    await db.end()
  }
}
