// After a park, the job resumes in a fresh browser with an empty form. Put back what the parked run had filled
// (checkpoint.filled) without asking the model again. Every value still goes through enforce() and dispatch(), so
// the sensitive-field rules, the commit gate, stale checks and the tripwire all apply. Fields that are gone, renamed
// or already filled are skipped and left to the normal planner; nothing is forced.
import { dispatch, enforce } from './actions/registry.mjs'
import { fieldSig, fieldPos } from './lessons.mjs'
import { isField, pageSignature } from './perception/walk.mjs'

const RESTORABLE = new Set(['fill', 'select', 'choose', 'check', 'type', 'set_date', 'upload'])
// One-time codes expire; a resumed run asks for or reads a fresh one.
const CODES = /\((EMAIL_CODE|SMS_CODE)\)/
const SECRET = /\((EMAIL|COVER_LETTER)\)/g

// A checkbox or radio carries a value attribute (Greenhouse: an option id) even when unticked; only checked counts.
const isBox = el => ['checkbox', 'radio'].includes(el.type) || ['checkbox', 'radio'].includes(el.role)
const isEmpty = el => !el.disabled && el.checked !== true && (isBox(el) || !el.value)

// The saved entry for a field: same page first, then any page (single-page apps reopen at the first step). Within
// that, signature plus position, then label plus position. The latest entry wins (a corrected answer replaces an
// earlier one). Entries already used are skipped, so one saved value fills one field.
export function matchEntry(saved, obs, el, used = new Set(), page = pageSignature(obs)) {
  const sig = fieldSig(el), pos = fieldPos(obs.elements, el)
  const usable = saved.filter(f => f && RESTORABLE.has(f.action) && !used.has(f))
  const last = list => list[list.length - 1] || null
  for (const pool of [usable.filter(f => f.page === page), usable]) {
    const hit = last(pool.filter(f => f.sig === sig && (f.pos ?? 0) === pos)) || last(pool.filter(f => f.label === el.label && (f.pos ?? 0) === pos))
    if (hit) return hit
  }
  return null
}

function actionFor(entry, el) {
  if (entry.action === 'upload') return el.file ? { action: 'upload', ref: el.ref, doc: entry.doc === 'cover_letter' ? 'cover_letter' : 'resume' } : null
  if (entry.action === 'check') return { action: 'check', ref: el.ref, source: 'restored', confidence: 'high', reason: 'restored after resume' }
  const value = String(entry.value ?? '').replace(SECRET, '{{$1}}')
  if (!value) return null
  return { action: entry.action, ref: el.ref, value, source: 'restored', confidence: 'high', reason: 'restored after resume' }
}

/**
 * The question the parked run was waiting on, answered while it was parked: ask again with the same prompt, which
 * reuses your answer (context.mjs ask) and fills the field, instead of the planner deciding to ask again.
 * Returns the label filled, or null.
 */
export async function restorePending(env, obs, pending) {
  if (!pending?.prompt || env.restored?.has(pending)) return null
  env.restored ??= new Set()
  const page = pageSignature(obs)
  const probe = { ...pending, action: 'fill' }
  const el = obs.elements.find(e => isField(e) && isEmpty(e) && matchEntry([probe], obs, e, new Set(), page))
  if (!el) return null
  env.restored.add(pending)
  const r = await dispatch(env, { action: 'ask_human', ref: el.ref, question: pending.prompt, options: pending.options || [], remember: pending.remember !== false }, { enforced: true })
  return r.result.startsWith('ok') ? el.label : null
}

/**
 * Re-applies saved values to the empty fields of this page. Returns [{ label, action }] for what was restored.
 * env.restored (a Set) remembers used entries across pages.
 */
export async function restoreFilled(env, obs, saved) {
  if (!Array.isArray(saved) || !saved.length) return []
  env.restored ??= new Set()
  const page = pageSignature(obs)
  const before = env.filled.length
  const done = []
  try {
    for (const el of obs.elements) {
      // Password fields are left to the account flow: a reset page wants {{NEW_PASSWORD}}, and a refused login must
      // not be typed again (account.mjs).
      if (!isField(el) || !isEmpty(el) || el.type === 'password') continue
      const entry = matchEntry(saved, obs, el, env.restored, page)
      if (!entry || CODES.test(String(entry.value))) continue
      const action = actionFor(entry, el)
      if (!action) continue
      // A rule that now asks you or stops (sensitive field, hard stop) wins; leave that field to the normal path.
      const checked = enforce(action, obs, env)
      if (checked.action !== action.action) continue
      env.restored.add(entry)
      const r = await dispatch(env, checked, { enforced: true })
      if (r.result.startsWith('ok')) done.push({ label: el.label, action: action.action })
    }
  } finally {
    // The checkpoint already lists these values (env.filled starts from it), so the approval summary and its hash
    // stay exactly as you saw them before the park, and an earlier approval is reused.
    env.filled.length = before
  }
  return done
}
