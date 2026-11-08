// Shared by the key drafter and the scoreboard runner: reach a posting's form, group the page's fields the way a
// person reads them (one question per checkbox or radio group), propose answers, and score a filled page against
// an answer key.
import { observe, isField, atsFrame } from '../worker/lib/perception/walk.mjs'
import { profileField, profileValue } from '../worker/fields.mjs'
import { findAnswer } from '../worker/lib/answers.mjs'
import { sensitiveDecision } from '../worker/lib/sensitive.mjs'

// "First Name* First Name" (a label plus its placeholder) -> "First Name".
export function cleanLabel(label) {
  const t = String(label || '').replace(/[*✱]/g, ' ').replace(/\s+/g, ' ').trim()
  const words = t.split(' ')
  for (let n = 1; n <= words.length / 2; n++) {
    if (words.length === 2 * n && words.slice(0, n).join(' ').toLowerCase() === words.slice(n).join(' ').toLowerCase()) return words.slice(0, n).join(' ')
  }
  return t
}
export const norm = s => String(s ?? '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').replace(/^[\s*:.-]+|[\s*:.-]+$/g, '').trim()
const APPLY = /^(apply|apply now|apply for this (job|position|role)|i'?m interested|start (your )?application)$/i

// Opens the posting and, when the form is behind an Apply button, clicks it once (navigation only; the guard and
// the dry-run submit block stay in force).
export async function openForm(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(2500)
  let obs = await observe(page, { maxElements: 300 })
  // A careers page that embeds the board's form in an iframe (Example Corp -> Greenhouse): open the form itself.
  const embedded = async () => {
    const frame = atsFrame(await page.evaluate(() => [...document.querySelectorAll('iframe')].map(f => f.src)).catch(() => []))
    if (!frame) return false
    await page.goto(frame, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(2500)
    return true
  }
  if (obs.fieldCount < 3 && await embedded()) obs = await observe(page, { maxElements: 300 })
  if (obs.fieldCount < 3) {
    const apply = obs.elements.find(e => ['button', 'link'].includes(e.role) && APPLY.test((e.label || '').trim()))
    if (apply) {
      await page.locator(`[data-agent-ref="${apply.ref}"]`).first().click({ timeout: 8000 }).catch(() => {})
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      await page.waitForTimeout(3000)
      await embedded()
      obs = await observe(page, { maxElements: 300 })
    }
  }
  return obs
}

const isBox = e => ['checkbox', 'radio'].includes(e.type) || ['checkbox', 'radio'].includes(e.role)

// The questions on the page: { label, kind: text|choice|check|checks|radio|file, required, options, value }.
// Checkbox and radio options labelled "Group > Option" become one question whose value is the ticked option(s).
export function questions(obs) {
  const out = []
  const groups = new Map()
  for (const e of obs.elements) {
    if (!isField(e) || ['button', 'submit', 'hidden'].includes(e.type) || e.role === 'button') continue
    if (isBox(e) && e.label.includes(' > ')) {
      const [group, ...rest] = e.label.split(' > ')
      const option = rest.join(' > ')
      let q = groups.get(group)
      if (!q) { q = { label: group, kind: e.type === 'radio' || e.role === 'radio' ? 'radio' : 'checks', required: false, options: [], picked: [] }; groups.set(group, q); out.push(q) }
      q.options.push(option)
      if (e.checked) q.picked.push(option)
      if (e.required) q.required = true
      continue
    }
    const kind = e.file || e.type === 'file' ? 'file' : isBox(e) ? 'check' : e.tag === 'select' || ['combobox', 'listbox'].includes(e.role) ? 'choice' : 'text'
    out.push({ label: e.label, kind, required: !!e.required, section: e.section || '', options: e.options?.slice(0, 30), value: kind === 'check' ? (e.checked ? 'checked' : '') : e.value || '', error: e.error || '' })
  }
  for (const q of out) if (q.picked) { q.value = q.kind === 'radio' ? q.picked[0] || '' : q.picked; delete q.picked }
  return out
}

const pickOption = (options, value) => {
  if (!options?.length || !value) return value || null
  const v = norm(value)
  return options.find(o => norm(o) === v) || options.find(o => norm(o).startsWith(v) || v.startsWith(norm(o))) || null
}

// A first answer key from the profile and answer bank. Anything it cannot fill is left null for you to set.
export function proposeKey(qs, profile, bank) {
  return qs.map(q => {
    const entry = { label: q.label, kind: q.kind, required: q.required, expected: null, source: 'TODO' }
    // "Select...", "Choose one", "--" are placeholders, not answers.
    if (q.options?.length) entry.options = q.options.filter(o => !/^(select|choose|please select|--)\b.*$|^\s*$/i.test(o.trim()) || /^select(ed)? (all|none)/i.test(o))
    if (q.kind === 'file') {
      // Upload buttons are often just "Attach"; the section heading says which document it is.
      const about = `${q.label} ${q.section || ''}`
      if (q.section) entry.section = q.section
      // "Autofill from resume" parses a file to pre-fill the form; it is not the application's résumé field.
      if (/autofill|parse/i.test(about)) return Object.assign(entry, { expected: '', source: 'not scored (autofill helper)', skip: true })
      if (/resume|\bcv\b|curriculum/i.test(about)) Object.assign(entry, { expected: 'resume', source: 'document' })
      else if (/cover/i.test(about)) Object.assign(entry, { expected: 'cover_letter', source: 'document' })
      else Object.assign(entry, { expected: '', source: 'leave empty' })
      return entry
    }
    const label = cleanLabel(q.label)
    const sens = sensitiveDecision(label, profile)
    let value = sens?.action === 'answer' ? sens.value : null
    let source = value ? 'sensitive (profile)' : null
    if (!value && !sens) {
      const field = profileField(label)
      value = field ? profileValue(profile, field) : null
      if (value) source = 'profile'
      if (!value) { const hit = findAnswer(label, bank, 0.6); if (hit) { value = hit.answer; source = 'answer bank' } }
    }
    if (value && q.options?.length) value = q.kind === 'checks' ? String(value).split(/[,;]/).map(v => pickOption(q.options, v.trim())).filter(Boolean) : pickOption(q.options, value)
    if (value && (!Array.isArray(value) || value.length)) Object.assign(entry, { expected: value, source })
    if (sens?.action === 'ask') entry.source = 'TODO (sensitive: you are asked each time)'
    return entry
  })
}

// Does a page value satisfy an expected value? expected: string | string[] (checkbox group) | { regex } |
// 'checked' | '' (must be left empty).
export function satisfies(value, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && expected.regex) return new RegExp(expected.regex, 'i').test(Array.isArray(value) ? value.join(', ') : String(value ?? ''))
  if (Array.isArray(expected)) {
    const got = new Set((Array.isArray(value) ? value : String(value || '').split(/,\s*/)).map(norm).filter(Boolean))
    const want = new Set(expected.map(norm))
    return got.size === want.size && [...want].every(w => got.has(w))
  }
  const g = norm(Array.isArray(value) ? value.join(', ') : value), w = norm(expected)
  if (!w) return !g
  if (g === w) return true
  // Phone numbers: same last 10 digits. Long text: the expected text is contained (sites trim or reflow).
  const gd = g.replace(/\D/g, ''), wd = w.replace(/\D/g, '')
  if (wd.length >= 8 && gd.endsWith(wd.slice(-10))) return true
  return w.length > 40 && g.includes(w.slice(0, 40))
}

const find = (qs, entry) => {
  const l = norm(entry.label), c = norm(cleanLabel(entry.label))
  const pool = entry.section ? qs.filter(q => norm(q.section) === norm(entry.section)) : qs
  return pool.find(q => norm(q.label) === l) || pool.find(q => norm(cleanLabel(q.label)) === c) || pool.find(q => norm(q.label).startsWith(l) || l.startsWith(norm(q.label)))
}

/**
 * Scores the page against a key. Returns { total, correct, wrong: [{label, expected, got}], resume_ok,
 * empty_required: [labels not in the key that are required and still empty] }.
 * Only entries marked required (or { score: true }) count toward total; others are reported in wrong but not counted.
 */
// Page labels closest to a label, by shared words (for "field not found": what the page called it instead).
export function nearestLabels(qs, label, n = 3) {
  const words = l => new Set(norm(cleanLabel(l)).split(/[^a-z0-9]+/).filter(w => w.length > 2))
  const want = words(label)
  return qs.map(q => ({ label: cleanLabel(q.label), score: [...words(q.label)].filter(w => want.has(w)).length }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, n).map(x => x.label)
}

export function scorePage(obs, key, { resumeName = '' } = {}) {
  const qs = questions(obs)
  const wrong = []
  let total = 0, correct = 0
  for (const entry of key.entries || []) {
    if (entry.expected === null || entry.expected === undefined || entry.skip) continue
    const counts = entry.required || entry.score
    const q = find(qs, entry)
    let ok
    if (entry.kind === 'file') ok = q ? (entry.expected ? !!q.value && !/required/i.test(q.error) : !q.value) : !entry.expected
    else ok = !!q && satisfies(q.value, entry.expected)
    if (counts) { total++; if (ok) correct++ }
    if (!ok) wrong.push({ label: entry.label, expected: entry.expected, got: q ? q.value : '(field not found)', counted: !!counts, ...(q ? {} : { near: nearestLabels(qs, entry.label) }) })
  }
  const keyed = new Set((key.entries || []).map(e => norm(e.label)))
  const empty_required = qs.filter(q => q.required && !keyed.has(norm(q.label)) && (Array.isArray(q.value) ? !q.value.length : !q.value)).map(q => q.label)
  const resumeQ = qs.find(q => q.kind === 'file' && /resume|\bcv\b|curriculum/i.test(q.label)) || qs.find(q => q.kind === 'file')
  const resumeError = obs.alerts.some(a => /(resume|cv)[^.]{0,40}required|required[^.]{0,40}(resume|cv)/i.test(a))
  // Some uploaders (Greenhouse) show the file's name beside the button and clear the <input type=file>.
  const nameShown = !!resumeName && String(obs.text || '').toLowerCase().includes(resumeName.toLowerCase())
  const resume_ok = resumeQ ? (!!resumeQ.value || nameShown) && !resumeError && !/required/i.test(resumeQ.error) : null
  return { total, correct, wrong, resume_ok, empty_required }
}

const entryKey = e => `${norm(cleanLabel(e.label))}|${norm(e.section || '')}`
const filled = e => (e.expected !== null && e.expected !== undefined) || e.skip === true

/**
 * Merges a fresh draft into a key file you have been editing. Entries you answered (non-null expected) or skipped
 * stay exactly as you left them; unanswered entries take the fresh proposal; new questions are added; answered
 * entries whose field is gone move to `orphans` (never dropped). Returns { entries, orphans, kept, added, refreshed }.
 */
export function mergeKey(existing = { entries: [] }, fresh = []) {
  const old = new Map()
  for (const e of existing.entries || []) old.set(entryKey(e), e)
  let kept = 0, added = 0, refreshed = 0
  const seen = new Set()
  const entries = fresh.map(f => {
    const k = entryKey(f); seen.add(k)
    const o = old.get(k)
    if (o && filled(o)) { kept++; return o }
    if (o) refreshed++; else added++
    return f
  })
  const orphans = [...(existing.orphans || []), ...(existing.entries || []).filter(e => filled(e) && !seen.has(entryKey(e)))]
  return { entries, orphans, kept, added, refreshed }
}

// Unanswered entries across key files, grouped by question so each is answered once:
// [{ question, kind, options, postings: [id], required }]
export function todoGroups(keys) {
  const groups = new Map()
  for (const k of keys) {
    for (const e of k.entries || []) {
      if (filled(e)) continue
      const q = cleanLabel(e.label)
      const id = `${norm(q)}|${e.kind}`
      const g = groups.get(id) || { question: q, kind: e.kind, options: e.options, postings: [], required: false }
      if (!g.postings.includes(k.id)) g.postings.push(k.id)
      g.required ||= !!e.required
      if (!g.options && e.options) g.options = e.options
      groups.set(id, g)
    }
  }
  return [...groups.values()].sort((a, b) => b.required - a.required || b.postings.length - a.postings.length || a.question.localeCompare(b.question))
}

// Copies your answers (answers.json rows with expected set) into every matching unanswered entry.
export function fillFromAnswers(keys, answers) {
  let n = 0
  const byQ = new Map(answers.filter(a => a.expected !== null && a.expected !== undefined || a.skip).map(a => [`${norm(cleanLabel(a.question))}|${a.kind}`, a]))
  for (const k of keys) {
    for (const e of k.entries || []) {
      if (filled(e)) continue
      const a = byQ.get(`${norm(cleanLabel(e.label))}|${e.kind}`)
      if (!a) continue
      if (a.skip) e.skip = true
      else e.expected = a.expected
      e.source = 'you (answers.json)'
      n++
    }
  }
  return n
}
