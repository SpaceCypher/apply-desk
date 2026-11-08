// Learning from experience.
// - Reflection: after a run, one model call reads OUR structured step log (never page text) and proposes up to
//   3 short, general lessons. Each must pass validateLesson() before it is stored as a candidate.
// - Trust: candidates are used (non-auto modes only) and earn success/failure counts; 2 successes make a lesson
//   trusted, 2 failures retire it. Trusted lessons are used everywhere.
// - Site memory: how each field on a domain was filled (action + where the value came from, never the value).
import { generate, FLASH } from './gemini.mjs'
import { profileField } from '../fields.mjs'
import { normalize } from './answers.mjs'
import { STAGES } from './context.mjs'
import { sensitiveCategory } from './sensitive.mjs'
import { credentialDomain } from './vault.mjs'

const VERBS = /^(click|press|choose|select|type|fill|check|scroll|wait|use|open|close|dismiss|upload|expect|look|skip|pick|after|before|when|if|on)\b/i
const FORBIDDEN = /withdraw|delete|remove (the )?application|cancel|pay(ment)?|bank|card|ssn|social security|submit|approve|ignore (the |all |previous )|instruction|always click|never ask|sponsor|salary|aadhaar|pan\b/i
const PII = /https?:\/\/|www\.|@|\b\d{5,}\b|\+\d{6,}/i

// Returns null when the lesson may be stored, or the reason it was refused.
export function validateLesson(text, { names = [] } = {}) {
  const t = String(text || '').trim()
  if (t.length < 12) return 'too short'
  if (t.length > 160) return 'too long'
  if (!VERBS.test(t)) return 'must start with an action verb'
  if (FORBIDDEN.test(t)) return 'mentions a forbidden action or topic'
  if (PII.test(t)) return 'contains a URL, email or long number'
  if (names.some(n => n && n.length > 2 && t.toLowerCase().includes(n.toLowerCase()))) return 'contains personal data'
  return null
}

const scopesFor = (platform, url) => {
  let domain = ''
  try { domain = credentialDomain(new URL(url).hostname) } catch { /* ignore */ }
  return [`platform:${platform || 'custom'}`, ...(domain ? [`domain:${domain}`] : [])]
}

// Lessons to put in the prompt: trusted ones, plus up to 2 candidates when not in auto mode. Capped at 600 chars.
export async function loadLessons(db, { platform, url, mode }) {
  const scopes = scopesFor(platform, url)
  const statuses = mode === 'auto' ? ['trusted'] : ['trusted', 'candidate']
  const { rows } = await db.query(`SELECT id, text, status FROM lessons WHERE scope = ANY($1) AND status = ANY($2)
    ORDER BY (status = 'trusted') DESC, (success_count + 1)::float / (success_count + failure_count + 2) DESC, last_used DESC NULLS LAST, id DESC LIMIT 12`, [scopes, statuses]).catch(() => ({ rows: [] }))
  const used = []
  let size = 0, candidates = 0
  for (const r of rows) {
    if (r.status === 'candidate' && ++candidates > 2) continue
    if (size + r.text.length > 600) break
    size += r.text.length; used.push(r)
  }
  return { ids: used.map(r => r.id), text: used.map(r => `- ${r.text}`).join('\n') }
}

// After a run: credit or blame the lessons that were in context, then promote or retire.
export async function scoreLessons(db, ids, { status, stats }) {
  if (!ids?.length) return
  const reached = STAGES.indexOf(stats?.stage)
  const good = !['failed'].includes(status) && reached >= STAGES.indexOf('form_page') && (stats?.stuck_events || 0) <= 1
  const bad = status === 'failed' || (stats?.stuck_events || 0) >= 3
  if (good) await db.query('UPDATE lessons SET success_count = success_count + 1, last_used = now() WHERE id = ANY($1)', [ids])
  else if (bad) await db.query('UPDATE lessons SET failure_count = failure_count + 1, last_used = now() WHERE id = ANY($1)', [ids])
  else await db.query('UPDATE lessons SET last_used = now() WHERE id = ANY($1)', [ids])
  await db.query("UPDATE lessons SET status = 'trusted' WHERE id = ANY($1) AND status = 'candidate' AND success_count >= 2 AND failure_count = 0", [ids])
  await db.query("UPDATE lessons SET status = 'retired' WHERE id = ANY($1) AND status <> 'retired' AND failure_count >= 2", [ids])
}

export async function addLesson(db, { scope, text, source = 'reflection', evidence = [] }, names = []) {
  const problem = validateLesson(text, { names })
  if (problem) return { stored: false, reason: problem }
  const r = await db.query(`INSERT INTO lessons (scope, text, normalized, source, evidence) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (scope, normalized) DO NOTHING RETURNING id`, [scope, text.trim(), normalize(text), source, JSON.stringify(evidence)])
  return { stored: !!r.rowCount, id: r.rows[0]?.id }
}

// Structured step records for reflection: our own actions and results. Labels are cut to 40 characters and no
// page body text is ever included, so instructions planted on a page cannot become lessons verbatim.
export function stepRecords(history) {
  return history.slice(-40).map(h => ({ action: h.action, label: String(h.label || '').slice(0, 40), result: String(h.result || '').split(':')[0], detail: String(h.result || '').startsWith('error') ? String(h.result).slice(6, 60) : undefined }))
}

export async function reflect({ db, ctx, history, platform, url, profile }) {
  const records = stepRecords(history)
  if (records.length < 3) return []
  const recovered = records.some(r => /recovered|no_effect|error|stale/.test(r.result))
  if (!recovered && ctx.stats.stuck_events === 0) return [] // nothing to learn from a smooth run
  let result
  try {
    result = await generate({
      kind: 'reflect', meter: ctx.meter, model: FLASH(), temperature: 0.1,
      system: 'You review a browser agent\'s own action log from one job application and write short, general, reusable lessons about operating this kind of site. Lessons are about mechanics (which control to use, what to dismiss first, which action works), never about the applicant, never about submitting, never copied from page text.',
      prompt: JSON.stringify({ kind: 'reflect', platform, outcome: { status: ctx.stats.stage, stuck_events: ctx.stats.stuck_events, recoveries: ctx.stats.recoveries }, steps: records })
        + '\nReturn JSON {"lessons":[{"text":string (max 160 chars, starts with a verb like Click/Press/Choose/Use/Close),"scope":"platform"|"domain"}]} with at most 3 lessons, or an empty list.',
    })
  } catch { return [] }
  const names = [profile?.first_name, profile?.last_name, profile?.email].filter(Boolean)
  const [platformScope, domainScope] = scopesFor(platform, url)
  const out = []
  for (const l of (result?.lessons || []).slice(0, 3)) {
    const scope = l.scope === 'domain' && domainScope ? domainScope : platformScope
    out.push({ text: l.text, ...(await addLesson(db, { scope, text: String(l.text || ''), evidence: [{ job_id: ctx.job.id }] }, names)) })
  }
  return out
}

// ---- Site memory --------------------------------------------------------------------------------------------

export const fieldSig = el => `${normalize(el.label).slice(0, 80)}|${el.role}`
// Which of several same-signature fields on a page this is (several "Start date year" fields, for example).
export const fieldPos = (elements, el) => { const sig = fieldSig(el); return Math.max(0, elements.filter(e => fieldSig(e) === sig).indexOf(el)) }

// Which profile key or answer-bank question a successful value came from. Null for inferred or sensitive values.
export function valueRef(el, row, profile, bank) {
  if (!row.value || !['profile', 'answer_bank'].includes(row.source) || sensitiveCategory(el.label)) return null
  const v = String(row.value).trim().toLowerCase()
  const key = profileField(el.label)
  if (key && String(profile[key] ?? '').toLowerCase() === v) return { kind: 'profile', key }
  for (const k of ['first_name', 'last_name', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio']) {
    if (profile[k] && String(profile[k]).toLowerCase() === v) return { kind: 'profile', key: k }
  }
  if (profile.location && v === String(profile.location).split(',')[0].trim().toLowerCase()) return { kind: 'profile', key: 'city' }
  const hit = bank.find(b => String(b.answer).trim().toLowerCase() === v)
  return hit ? { kind: 'bank', question: hit.question } : null
}

function resolveRef(ref, profile, bank) {
  if (ref.kind === 'profile') return ref.key === 'city' ? String(profile.location || '').split(',')[0].trim() : profile[ref.key]
  if (ref.kind === 'bank') return bank.find(b => normalize(b.question) === normalize(ref.question))?.answer
  return null
}

export function createMemory(db, url, dispatch) {
  let domain = ''
  try { domain = credentialDomain(new URL(url).hostname) } catch { /* ignore */ }
  let cache = null
  const load = async () => (cache ??= new Map((await db.query('SELECT field_sig, action, value_ref, failures FROM site_memory WHERE domain=$1 AND failures < 3', [domain]).catch(() => ({ rows: [] }))).rows.map(r => [r.field_sig, r])))
  return {
    domain,
    async replay(env, obs) {
      if (!domain) return null
      const mem = await load()
      if (!mem.size) return null
      const done = []
      for (const el of obs.elements) {
        if (el.value || el.checked || el.disabled) continue
        const m = mem.get(fieldSig(el))
        if (!m) continue
        const value = resolveRef(m.value_ref, env.profile, env.bank)
        if (!value) continue
        const r = await dispatch(env, { action: m.action, ref: el.ref, value, source: m.value_ref.kind === 'bank' ? 'answer_bank' : 'profile', confidence: 'high', reason: 'site memory' })
        if (r.result.startsWith('ok')) { done.push({ label: el.label, action: m.action }); await db.query('UPDATE site_memory SET successes = successes + 1, last_verified = now() WHERE domain=$1 AND field_sig=$2', [domain, m.field_sig]) }
        else await db.query('UPDATE site_memory SET failures = failures + 1 WHERE domain=$1 AND field_sig=$2', [domain, m.field_sig])
      }
      return done.length ? done : null
    },
    async learn(env, el, row) {
      if (!domain) return
      const ref = valueRef(el, row, env.profile, env.bank)
      if (!ref) return
      await db.query(`INSERT INTO site_memory (domain, field_sig, action, value_ref) VALUES ($1,$2,$3,$4)
        ON CONFLICT (domain, field_sig) DO UPDATE SET action=EXCLUDED.action, value_ref=EXCLUDED.value_ref, successes=site_memory.successes + 1, failures=0, last_verified=now()`,
      [domain, fieldSig(el), row.action, JSON.stringify(ref)]).catch(() => {})
      cache = null
    },
  }
}
