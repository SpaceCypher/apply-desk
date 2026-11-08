import { putBlob } from './storage.mjs'
import { notify, optionButtons, sendPhoto } from './telegram.mjs'
import { redact } from './security.mjs'
import { normalize } from './answers.mjs'
import { estimateCost } from './gemini.mjs'

// How far a run got, in order. The bench scores on this.
export const STAGES = ['opened', 'apply_clicked', 'account_wall', 'form_page', 'reached_submit', 'submitted']

export class Stop extends Error {
  constructor(status, note, { parked = false } = {}) { super(note); this.status = status; this.note = note; this.parked = parked }
}

// An earlier answer may be reused only for the same question and, for approvals, the same content hash.
const contextMatches = (stored, wanted) => !wanted?.hash || stored?.hash === wanted.hash

// Everything the run needs: db, job, secrets, logging, and human questions.
export function createContext({ db, job, workerId, settings }) {
  const secrets = {}
  let stepNo = 0
  const ctx = {
    db, job, settings, secrets, workerId,
    flags: [],
    // Counters for cost, the bench and the job page.
    stats: { model_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0, questions: 0, stuck_events: 0, recoveries: 0, safety_violations: 0, pages: 0, stage: 'opened', handoff: null },
    meter: {
      add(model, tokensIn, tokensOut) {
        ctx.stats.model_calls++; ctx.stats.tokens_in += tokensIn; ctx.stats.tokens_out += tokensOut
        ctx.stats.cost += estimateCost(model, tokensIn, tokensOut)
      },
    },
    // Records progress; only moves forward.
    stage(name, detail) {
      if (STAGES.indexOf(name) > STAGES.indexOf(ctx.stats.stage)) ctx.stats.stage = name
      if (name === 'form_page') ctx.stats.pages++
      if (detail?.handoff) ctx.stats.handoff = detail.handoff
    },
    notify: (text, buttons) => notify(text, buttons),
    askTimeoutMs: Number(process.env.ASK_TIMEOUT_MINUTES || 45) * 60000,
    secretValues: () => Object.values(secrets).filter(Boolean),

    async heartbeat() {
      const r = await db.query("UPDATE jobs SET lease_until = now() + interval '15 minutes', updated_at = now() WHERE id=$1 AND claimed_by=$2 RETURNING id", [job.id, workerId])
      if (!r.rowCount) throw new Stop('cancelled', 'Lost the job lease')
      const kill = (await db.query("SELECT value FROM settings WHERE key='kill_switch'")).rows[0]?.value
      if (kill === true) throw new Stop('cancelled', 'Kill switch engaged')
      const status = (await db.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0]?.status
      if (status === 'cancelled') throw new Stop('cancelled', 'Cancelled from the app')
    },

    async audit(action, detail = {}) {
      const text = redact(detail, ctx.secretValues())
      await db.query('INSERT INTO audit_log (job_id, action, detail) VALUES ($1,$2,$3)', [job.id, action, text])
    },

    async step(kind, detail, shot) {
      let key = null
      if (shot) key = await putBlob(db, `jobs/${job.id}/${String(++stepNo).padStart(3, '0')}.png`, shot, 'image/png').catch(() => null)
      const text = redact(detail, ctx.secretValues())
      await db.query('INSERT INTO job_steps (job_id, kind, detail, screenshot_key) VALUES ($1,$2,$3,$4)', [job.id, kind, text, key])
      return key
    },

    async flag(message) {
      ctx.flags.push(message)
      await db.query('UPDATE jobs SET flags = $2::jsonb WHERE id=$1', [job.id, JSON.stringify(ctx.flags.slice(-50))])
    },

    async setStatus(status, note) {
      await db.query('UPDATE jobs SET status=$2, note=COALESCE($3, note), updated_at=now() WHERE id=$1 AND claimed_by=$4', [job.id, status, note ?? null, workerId])
    },

    // Ask the user. Reuses an answer given while the job was parked (resume). Otherwise waits up to
    // parkAfterMs (production: a couple of minutes), then parks the job via ctx.park() so no runner is held;
    // without park it waits up to timeoutMs. Question answers are saved to the answer bank when used.
    async ask({ kind = 'question', prompt, options = [], photo, remember = true, timeoutMs = ctx.askTimeoutMs, context = null }) {
      const remember_ = async answer => {
        if (kind === 'question' && remember && String(answer).trim()) {
          await db.query('INSERT INTO answer_bank (question, normalized, answer) VALUES ($1,$2,$3) ON CONFLICT (normalized) DO UPDATE SET answer=EXCLUDED.answer',
            [prompt.slice(0, 500), normalize(prompt).slice(0, 500), answer])
        }
        return answer
      }
      // An approval is identified by its content hash, not its wording: the prompt also lists flags, which change
      // between a parked run and its resume, so matching on the prompt asked for the same approval again.
      const [match, key] = context?.hash ? ["context->>'hash'=$3", context.hash] : ['prompt=$3', prompt]
      const prior = (await db.query(`SELECT id, answer, context FROM questions WHERE job_id=$1 AND kind=$2 AND ${match} AND answer IS NOT NULL AND COALESCE(context->>'consumed', '') = '' ORDER BY id DESC LIMIT 1`,
        [job.id, kind, key]).catch(() => ({ rows: [] }))).rows[0]
      if (prior && contextMatches(prior.context, context)) {
        await db.query("UPDATE questions SET context = COALESCE(context, '{}'::jsonb) || '{\"consumed\": \"1\"}'::jsonb WHERE id=$1", [prior.id])
        return remember_(prior.answer)
      }
      let row = (await db.query(`SELECT id FROM questions WHERE job_id=$1 AND kind=$2 AND ${match} AND answer IS NULL ORDER BY id DESC LIMIT 1`, [job.id, kind, key]).catch(() => ({ rows: [] }))).rows[0]
      if (!row) {
        row = (await db.query('INSERT INTO questions (job_id, kind, prompt, options, context) VALUES ($1,$2,$3,$4,$5) RETURNING id', [job.id, kind, prompt, JSON.stringify(options), context ? JSON.stringify(context) : null])).rows[0]
        if (photo) await sendPhoto(photo, `Job ${job.application_url}\n${prompt}`)
        const hint = options.length ? '' : '\nReply to this message with your answer.'
        ctx.stats.questions++
        await ctx.notify(`${kind === 'question' ? 'Question' : kind.toUpperCase()} for ${job.application_url}\n${prompt}${hint}\n/job ${job.id.slice(0, 8)}`, options.length ? optionButtons(row.id, options) : undefined)
      }
      await ctx.setStatus(kind === 'approval' ? 'awaiting_approval' : 'needs_user')
      const canPark = ctx.park && !['captcha', 'sms'].includes(kind)
      const deadline = Date.now() + (canPark ? ctx.parkAfterMs : timeoutMs)
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000))
        await ctx.heartbeat()
        const answered = (await db.query('SELECT answer FROM questions WHERE id=$1', [row.id])).rows[0]?.answer
        if (answered != null) {
          await db.query("UPDATE questions SET context = COALESCE(context, '{}'::jsonb) || '{\"consumed\": \"1\"}'::jsonb WHERE id=$1", [row.id])
          await ctx.setStatus('running')
          return remember_(answered)
        }
      }
      if (canPark) await ctx.park(kind)
      throw new Stop('needs_user', `Waiting for your answer: ${prompt}`)
    },
  }
  return ctx
}
