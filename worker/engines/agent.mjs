// The current engine (agent-v2: perception, page plans, the action registry, recovery) behind the scoreboard's
// engine interface. Runs the real runJob in dry run against a scratch database, with your profile and answer bank,
// and hands the page to score() before the browser closes.
import { randomUUID } from 'node:crypto'
import { runJob } from '../lib/session.mjs'

export const name = 'agent'

/**
 * fill({ db, url, profile, bank, settings, policy, resumePdf, ask, score })
 *   db: the scratch database (jobs and steps go there, never to your queue)
 *   ask({ prompt, options, kind }): stands in for your Telegram answer
 *   score(page): called for each open page before the browser closes; the runner keeps the best
 * Returns { status, note, stage, stats, writes, steps }.
 */
export async function fill({ db, url, profile, bank, settings, policy, resumePdf, ask, score }) {
  const id = randomUUID(), workerId = `scoreboard-${id.slice(0, 8)}`
  await db.query("INSERT INTO jobs (id, application_url, mode, status, claimed_by, lease_until) VALUES ($1,$2,'dry_run','running',$3, now() + interval '1 hour')", [id, url, workerId])
  const job = (await db.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0]
  let ctx = null
  const result = await runJob({
    db, job, workerId, settings, policy,
    bench: {
      profile, bank, noMemory: true, noReflect: true,
      // Scoring runs only: the résumé may attach to known ATS upload storage. The application is still never sent.
      allowUploads: true,
      upload: async kind => (kind === 'cover_letter_text' ? '' : resumePdf),
      configure(c) {
        ctx = c
        c.notify = async () => {}
        c.heartbeat = async () => {}
        c.ask = async q => { c.stats.questions++; return ask(q) }
      },
      inspect: score,
    },
  })
  const steps = (await db.query('SELECT count(*)::int n FROM job_steps WHERE job_id=$1', [id])).rows[0].n
  return { status: result.status, note: result.note, stage: result.stats?.stage || ctx?.stats?.stage || 'opened', stats: result.stats || ctx?.stats || {}, writes: ctx?.writes?.log || [], steps }
}
