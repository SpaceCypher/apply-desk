// Engine scoreboard: runs an engine on the scored postings in dry run and scores what ends up on the page against
// your answer keys. Nothing is ever submitted: dry run blocks every write except a résumé upload to known ATS
// storage (scoring runs only), and the form's own submit event is blocked.
//
//   node scoreboard/run.mjs --engine agent [--platform lever] [--id 7] [--runs 2]
//
// SOURCE_DATABASE_URL: your Neon database. Read: profile, answer bank, settings, scored postings and keys.
//                      Written: scoreboard_runs only.
// DATABASE_URL:        a scratch Postgres (migrated). The dry-run jobs and steps go there, never to your queue.
import { writeFile, mkdtemp, appendFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { createPolicy, isAllowedHost } from '../worker/lib/security.mjs'
import { observe } from '../worker/lib/perception/walk.mjs'
import { STAGES } from '../worker/lib/context.mjs'
import { findAnswer } from '../worker/lib/answers.mjs'
import { tailorResume, resumeHtml, htmlToPdf } from '../worker/lib/documents.mjs'
import { scorePage, cleanLabel, questions } from './lib.mjs'

const ENGINES = { agent: () => import('../worker/engines/agent.mjs'), stagehand: () => import('../worker/engines/stagehand.mjs') }

// A literal answer for a question whose key holds a pattern ("^state" -> "state", "^(bengaluru|bangalore)" ->
// "bengaluru"); "." (anything) has none.
export function literalOf(expected) {
  if (Array.isArray(expected)) return expected.join(', ')
  if (expected && typeof expected === 'object') {
    const r = String(expected.regex || '').replace(/^\^/, '').replace(/\$$/, '').replace(/^\((.*)\)$/, '$1').split('|')[0].replace(/\\(.)/g, '$1')
    return /^[\w\s.,'/&+-]+$/.test(r) && r.replace(/[.\s]/g, '') ? r : null
  }
  return expected === null || expected === undefined ? null : String(expected)
}

// Stands in for your Telegram reply: the key's answer for that question, else the answer bank, else nothing useful.
export function answerer(key, bank) {
  const fromKey = (key.entries || []).map(e => ({ question: cleanLabel(e.label), answer: e.skip ? null : literalOf(e.expected) })).filter(e => e.answer)
  return async ({ prompt, options = [], kind }) => {
    if (kind === 'approval') return 'Reject'
    if (kind === 'captcha' || kind === 'sms') return 'skip'
    if (options.includes('skip')) return 'skip'
    const hit = findAnswer(prompt, fromKey, 0.5) || findAnswer(prompt, bank, 0.5)
    if (hit) return hit.answer
    return options.find(o => /prefer not|decline/i.test(o)) || options[0] || 'Not applicable'
  }
}

// The page as the scorer reads it: inside allowlisted iframes too, as the agent does (Example Corp embeds its Greenhouse
// form in one).
export function observeForm(page, jobUrl, allowedDomains = []) {
  return observe(page, { maxElements: 300, frameFilter: u => isAllowedHost(u.hostname, jobUrl, allowedDomains) }).catch(() => null)
}

async function saveEvidence({ engine, posting, attempt, best, sc }) {
  const dir = path.resolve(process.env.SCOREBOARD_OUT || 'scoreboard-out')
  await mkdir(dir, { recursive: true })
  const base = path.join(dir, `${posting.id}-${posting.platform}-${engine}-run${attempt}`)
  if (best.shot) await writeFile(`${base}.png`, best.shot)
  const labels = questions(best.obs).map(q => ({ label: q.label, kind: q.kind, required: q.required, filled: Array.isArray(q.value) ? q.value.length > 0 : !!q.value }))
  await writeFile(`${base}.json`, JSON.stringify({ url: best.url, wrong: sc.wrong.map(w => ({ label: w.label, near: w.near })), questions: labels }, null, 2))
}

async function makeResume(profile) {
  // The résumé's content is not scored, only that it attaches. Built from your profile without a model call.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scoreboard-'))
  const file = path.join(dir, `${[profile.first_name, profile.last_name].filter(Boolean).join('_') || 'Resume'}_Resume.pdf`)
  const doc = await tailorResume(profile, { must_have: [], keywords: [] }, { mode: 'master' })
  await writeFile(file, await htmlToPdf(size => resumeHtml(profile, doc, size)))
  return file
}

/**
 * runScoreboard({ source, scratch, engine, only: { platform, id }, runs, policy, resumePdf, log })
 * Returns the rows written to scoreboard_runs.
 */
export async function runScoreboard({ source, scratch, engine = 'agent', only = {}, runs = 2, policy = createPolicy(), resumePdf = null, runId = String(Date.now()), log = console.log }) {
  const eng = await ENGINES[engine]?.()
  if (!eng) throw new Error(`Unknown engine ${engine}; known: ${Object.keys(ENGINES).join(', ')}`)
  const where = ['active', 'NOT spare'], params = []
  if (only.platform && only.platform !== 'all') { params.push(only.platform); where.push(`platform=$${params.length}`) }
  if (only.id) { params.push(Number(only.id)); where.push(`id=$${params.length}`) }
  const postings = (await source.query(`SELECT id, platform, url, title, key FROM scoreboard_postings WHERE ${where.join(' AND ')} ORDER BY platform, id`, params)).rows
  const profile = (await source.query('SELECT fields FROM profile WHERE id=true')).rows[0]?.fields || {}
  const bank = (await source.query('SELECT question, answer FROM answer_bank')).rows
  const stored = Object.fromEntries((await source.query('SELECT key, value FROM settings')).rows.map(r => [r.key, r.value]))
  const settings = { max_steps: 80, max_minutes: 15, kill_switch: false, allowed_domains: Array.isArray(stored.allowed_domains) ? stored.allowed_domains : [] }
  resumePdf ??= await makeResume(profile)

  const rows = []
  for (const p of postings) {
    const key = p.key || { entries: [] }
    const untilSignIn = key.until === 'sign_in'
    for (let attempt = 1; attempt <= runs; attempt++) {
      let best = null
      const started = Date.now()
      const r = await eng.fill({
        db: scratch, url: p.url, profile, bank, settings, policy, resumePdf, ask: answerer(key, bank),
        // Keep the open page with the most fields: that is the form, whatever else is open.
        score: async page => {
          const obs = await observeForm(page, p.url, settings.allowed_domains)
          if (obs && (!best || obs.fieldCount > best.obs.fieldCount)) best = { obs, url: page.url(), shot: await page.screenshot({ fullPage: true }).catch(() => null) }
        },
      })
      const s = r.stats || {}
      const sc = untilSignIn || !best ? { total: 0, correct: 0, wrong: [], resume_ok: null, empty_required: [] } : scorePage(best.obs, key, { resumeName: path.basename(resumePdf) })
      const reached = untilSignIn ? STAGES.indexOf(r.stage) >= STAGES.indexOf('account_wall') : STAGES.indexOf(r.stage) >= STAGES.indexOf('reached_submit')
      const writes = r.writes || []
      const row = {
        run_id: runId, engine, platform: p.platform, posting_id: p.id, url: p.url, attempt, reached_submit: reached, stage: r.stage,
        fields_total: sc.total, fields_correct: sc.correct, wrong: JSON.stringify(sc.wrong.slice(0, 40)), resume_ok: sc.resume_ok,
        steps: r.steps || 0, seconds: Math.round((Date.now() - started) / 100) / 10, tokens_in: s.tokens_in || 0, tokens_out: s.tokens_out || 0,
        cost: Number((s.cost || 0).toFixed(5)), questions: s.questions || 0, writes: JSON.stringify(writes.slice(0, 200)),
        note: [r.status === 'closed' ? 'posting closed: swap in a spare' : null, r.note, sc.empty_required.length ? `required but empty: ${sc.empty_required.slice(0, 5).join('; ')}` : null].filter(Boolean).join(' · ').slice(0, 500),
        commit: process.env.GITHUB_SHA?.slice(0, 7) || null,
      }
      // A run that is not fully correct leaves its evidence for the workflow artifact: the page as scored, and its
      // questions (labels and kinds only, no values).
      if (best && !untilSignIn && (sc.correct < sc.total || sc.resume_ok === false)) await saveEvidence({ engine, posting: p, attempt, best, sc }).catch(() => {})
      const cols = Object.keys(row)
      await source.query(`INSERT INTO scoreboard_runs (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map(c => row[c]))
      rows.push({ ...row, title: p.title, until: key.until, wrongList: sc.wrong, emptyRequired: sc.empty_required, blocked: writes.filter(w => !w.allowed).length, allowedWrites: writes.filter(w => w.allowed && w.why !== 'graphql query (read)').length })
      log(`#${p.id} ${p.platform} run ${attempt}: ${reached ? 'reached' : 'did not reach'} ${untilSignIn ? 'sign-in' : 'Submit'} · ${untilSignIn ? '' : `${sc.correct}/${sc.total} fields · résumé ${sc.resume_ok === null ? 'n/a' : sc.resume_ok ? 'yes' : 'NO'} · `}${row.questions} questions · ${row.steps} steps · ${row.seconds}s · $${row.cost}`)
    }
  }
  return rows
}

// Markdown tables: one row per run, then per platform against the auto bar (3 postings x 2 runs, all correct).
export function report(rows, engine) {
  const yes = b => (b === null || b === undefined ? 'n/a' : b ? 'yes' : '**no**')
  const lines = [`## Scoreboard: ${engine}`, '', '| Posting | Run | Reached | Fields correct | Résumé | Questions | Steps | Time | Cost | Writes blocked / allowed | First wrong | Unfilled required (not in key) |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
  for (const r of rows) {
    const fields = r.until === 'sign_in' ? 'up to sign-in' : `${r.fields_correct}/${r.fields_total}`
    const wrong = (r.wrongList || []).filter(w => w.counted).slice(0, 4).map(w => `${cleanLabel(w.label).slice(0, 40)}: ${w.near ? `not found${w.near.length ? ` (page has: ${w.near.map(l => l.slice(0, 30)).join(' / ')})` : ''}` : JSON.stringify(w.got).slice(0, 30)}`).join('; ')
    const unfilled = (r.emptyRequired || []).length ? `${r.emptyRequired.length}: ${r.emptyRequired.slice(0, 3).map(l => cleanLabel(l).slice(0, 30)).join(' / ')}` : ''
    lines.push(`| #${r.posting_id} ${r.platform} ${(r.title || '').slice(0, 30)} | ${r.attempt} | ${yes(r.reached_submit)} | ${fields} | ${yes(r.resume_ok)} | ${r.questions} | ${r.steps} | ${r.seconds}s | $${r.cost} | ${r.blocked} / ${r.allowedWrites} | ${wrong || ''} | ${unfilled} |`)
  }
  // Which writes the guard blocked, per posting (host and path, counted), so a blocked upload is easy to spot.
  const blockedBy = {}
  for (const r of rows) for (const w of JSON.parse(r.writes || '[]')) if (!w.allowed) {
    // Name the GraphQL operation too (?op= or ?operationName=): one endpoint serves both reads and the upload.
    let k = w.url; try { const u = new URL(w.url); const op = u.searchParams.get('op') || u.searchParams.get('operationName'); k = `${w.method} ${u.host}${u.pathname.slice(0, 60)}${op ? `?op=${op.slice(0, 60)}` : ''}` } catch { /* keep the raw url */ }
    const m = (blockedBy[`#${r.posting_id} ${r.platform}`] ??= {}); m[k] = (m[k] || 0) + 1
  }
  if (Object.keys(blockedBy).length) {
    lines.push('', '**Blocked writes** (dry run; nothing was sent)', '')
    for (const [posting, m] of Object.entries(blockedBy)) lines.push(`- ${posting}: ${Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `\`${k}\` ×${n}`).join(', ')}`)
  }
  lines.push('', '| Platform | Postings scored | Runs fully correct | Auto bar (3 postings x 2 runs) |', '|---|---|---|---|')
  const byPlatform = {}
  for (const r of rows) (byPlatform[r.platform] ??= []).push(r)
  for (const [platform, rs] of Object.entries(byPlatform)) {
    const perfect = rs.filter(r => r.reached_submit && (r.until === 'sign_in' || (r.fields_correct === r.fields_total && r.fields_total > 0 && r.resume_ok !== false)))
    const postings = new Set(rs.map(r => r.posting_id)).size
    const bar = rs[0].until === 'sign_in' ? 'stays in Review (account wall)' : postings >= 3 && perfect.length === rs.length && rs.length >= 6 ? 'met' : `not yet (${postings} of 3 postings scored)`
    lines.push(`| ${platform} | ${postings} | ${perfect.length}/${rs.length} | ${bar} |`)
  }
  return lines.join('\n') + '\n'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d)
  const source = new pg.Client({ connectionString: process.env.SOURCE_DATABASE_URL })
  const scratch = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await source.connect(); await scratch.connect()
  try {
    const engine = arg('engine', 'agent')
    const rows = await runScoreboard({ source, scratch, engine, only: { platform: arg('platform'), id: arg('id') }, runs: Number(arg('runs', 2)), runId: process.env.GITHUB_RUN_ID || String(Date.now()) })
    const md = report(rows, engine)
    console.log('\n' + md)
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md)
  } finally {
    await source.end(); await scratch.end()
  }
}
