// Recovery ladder: when an element action had no effect or failed, try other ways of doing the same thing,
// each at most once per element and page. Every rung goes through dispatch(), so the commit gate still applies.
import { dispatch } from './actions/registry.mjs'
import { locate } from './perception/walk.mjs'

const CLICKY = new Set(['click', 'check', 'add_entry', 'upload'])
const VALUE = new Set(['fill', 'select', 'choose', 'type', 'set_date'])

function rungsFor(action, el) {
  if (CLICKY.has(action.action)) return ['escape', 'scroll', 'click_at', 'keyboard']
  if (VALUE.has(action.action)) {
    const list = []
    if (action.action !== 'choose' && el.tag !== 'select') list.push('as_choose')
    if (action.action !== 'type') list.push('as_type')
    list.push('escape')
    return list
  }
  return []
}

// tried: Set shared across the run. Returns the successful { result, rung } or null when the ladder is exhausted.
export async function recover(env, action, el, tried, pageSig) {
  for (const rung of rungsFor(action, el)) {
    const key = `${pageSig}|${el.ref}|${el.label}|${action.action}|${rung}`
    if (tried.has(key)) continue
    tried.add(key)
    env.ctx.stats.recoveries++
    let r
    const same = { ...action, ref: el.ref }
    switch (rung) {
      case 'escape':
        await dispatch(env, { action: 'press_key', key: 'Escape' })
        r = await dispatch(env, same, { enforced: true })
        break
      case 'scroll':
        await locate(env.obs, el.ref).scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
        r = await dispatch(env, same, { enforced: true })
        break
      case 'click_at': {
        const box = await locate(env.obs, el.ref).boundingBox().catch(() => null)
        const rect = box ? { x: box.x, y: box.y, w: box.width, h: box.height } : el.rect
        if (!rect?.w) continue
        r = await dispatch(env, { action: 'click_at', x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) })
        if (r.result.startsWith('ok') && action.action === 'check') {
          const checked = await locate(env.obs, el.ref).evaluate(n => n.checked ?? n.getAttribute('aria-checked') === 'true').catch(() => false)
          if (!checked) r = { ...r, result: 'no_effect' }
        }
        break
      }
      case 'keyboard':
        await locate(env.obs, el.ref).focus({ timeout: 2000 }).catch(() => {})
        r = await dispatch(env, { action: 'press_key', key: ['checkbox', 'radio'].includes(el.type) || ['checkbox', 'radio'].includes(el.role) ? 'Space' : 'Enter' })
        break
      case 'as_choose':
        r = await dispatch(env, { ...same, action: 'choose' }, { enforced: true })
        break
      case 'as_type':
        r = await dispatch(env, { ...same, action: 'type' }, { enforced: true })
        break
    }
    await env.ctx.step('recovery', { rung, label: el.label, action: action.action, result: r?.result })
    if (r && (r.result.startsWith('ok') || r.result === 'dry_run_done' || r.result.startsWith('submitted:'))) return { ...r, rung }
  }
  return null
}
