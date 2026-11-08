// The only way the agent touches a page. Every action goes through dispatch(): enforce (confidence, sensitive
// fields, hard stops) -> stale check -> commit gate (anything that could submit is routed through submit())
// -> run -> verify -> submit tripwire.
import { createHash } from 'node:crypto'
import { forbiddenRequest, isAllowedHost, redact } from '../security.mjs'
import { sensitiveDecision } from '../sensitive.mjs'
import { profileCorpus } from '../facts.mjs'
import { Stop } from '../context.mjs'
import { credentialDomain } from '../vault.mjs'
import { accountSecret, afterAccountAction, verificationSince, getCredential } from '../account.mjs'
import { waitForVerification } from '../mail.mjs'
import { locate, stillSame, isSubmitControl, looksConfirmed, isField, frameOf, pageSignature, accountPage, observe } from '../perception/walk.mjs'
import { fieldSig, fieldPos } from '../lessons.mjs'
import { screenshot } from '../perception/marks.mjs'
import { skillsFor } from '../skills/index.mjs'

export const PLACEHOLDER = /\{\{(EMAIL|PASSWORD|NEW_PASSWORD|EMAIL_CODE|SMS_CODE|COVER_LETTER)\}\}/g
const ELEMENT_ACTIONS = new Set(['fill', 'select', 'choose', 'check', 'click', 'upload', 'type', 'hover', 'set_date', 'add_entry'])
const VALUE_ACTIONS = new Set(['fill', 'select', 'choose', 'check', 'type', 'set_date'])
export const KEYS = new Set(['Escape', 'Enter', 'Tab', 'Shift+Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace', 'Home', 'End', 'PageDown', 'PageUp'])
export const ACTION_NAMES = ['fill', 'select', 'choose', 'check', 'click', 'click_at', 'type', 'press_key', 'hover', 'set_date', 'add_entry', 'upload',
  'scroll', 'wait', 'goto', 'skill', 'batch', 'ask_human', 'read_email', 'open_email_link', 'finish']

export const findEl = (obs, a) => obs.elements.find(e => e.ref === String(a.ref ?? '')) || (Number.isInteger(a.index) ? obs.elements[a.index] : undefined)
const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
const digits = s => String(s ?? '').replace(/\D/g, '')
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function resolvePlaceholders(value, secrets) {
  const missing = []
  const out = String(value).replace(PLACEHOLDER, (_, key) => {
    if (secrets[key] == null) { missing.push(key); return '' }
    return secrets[key]
  })
  return { value: out, missing }
}

const PLACEHOLDER_ANSWER = /^(n\/?a|na|none|nil|null|not applicable|not available|-+|\.+|tbd|unknown)$/i
// Questions whose answer is a fact about you (pay, notice, experience, employer, links, content), not a judgement.
const FACTUAL_QUESTION = /\b(ctc|salary|compensation|pay|notice|years? of|how many years|total (years|work experience|experience)|company|employer|organi[sz]ation|title|designation|url|link|website|portfolio|github|linkedin|twitter|x handle|handle|content you'?ve created|share (some )?(content|work)|gpa|cgpa|grade|percentage|graduat|school|university|college|degree|major|discipline|referr?(ed|al)|phone|address|city|country|zip|postal)\b/i
const factBacked = (value, profile, bank) => {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return false
  return profileCorpus(profile).toLowerCase().includes(v) || bank.some(b => String(b.answer).trim().toLowerCase() === v)
}

// Confidence, sensitive-field and hard-stop rules. Returns the action to run (possibly ask_human, hard_stop, invalid).
export function enforce(action, obs, { profile, bank }) {
  if (!ACTION_NAMES.includes(action.action)) return { action: 'invalid', reason: `Unknown action ${action.action}` }
  const el = ELEMENT_ACTIONS.has(action.action) ? findEl(obs, action) : null
  if (ELEMENT_ACTIONS.has(action.action) && !el) return { action: 'invalid', reason: `No element ${action.ref ?? action.index}` }
  if (el && (VALUE_ACTIONS.has(action.action) || action.action === 'upload')) {
    const hard = forbiddenRequest(el.label)
    if (hard) return { action: 'hard_stop', reason: `Field asks for restricted data: ${el.label}` }
    const sens = sensitiveDecision(el.label, profile)
    if (sens?.action === 'ask') return { action: 'ask_human', ref: el.ref, question: el.label, options: el.options || [], remember: false, reason: 'sensitive field' }
    if (sens?.action === 'answer' && action.action !== 'upload') return { ...action, ref: el.ref, value: sens.value, source: 'profile', confidence: 'high' }
  }
  if (VALUE_ACTIONS.has(action.action)) {
    if (action.source === 'unknown' || action.confidence === 'low') {
      return { action: 'ask_human', ref: el.ref, question: el.label || 'Unlabelled field', options: el.options || [], reason: 'low confidence' }
    }
    let checked = action
    if (action.action !== 'check' && action.source === 'profile' && action.confidence === 'high') {
      const placeholder = new RegExp(PLACEHOLDER.source).test(action.value || '')
      const v = String(action.value || '').toLowerCase()
      const known = placeholder || profileCorpus(profile).toLowerCase().includes(v) || bank.some(b => String(b.answer).toLowerCase() === v)
      if (!known) checked = { ...action, ref: el.ref, confidence: 'medium', source: 'inferred', downgraded: true }
    }
    // A free-text answer to a factual question must come from your facts. A guessed or placeholder value ("N/A",
    // "None", made-up prose for "share content you've created") is asked instead; your answer is kept for next time.
    if (['fill', 'type'].includes(checked.action) && !new RegExp(PLACEHOLDER.source).test(checked.value || '')) {
      const placeholder = PLACEHOLDER_ANSWER.test(String(checked.value ?? '').trim())
      const guessed = checked.source === 'inferred' && FACTUAL_QUESTION.test(el.label || '')
      if ((placeholder || guessed) && !factBacked(checked.value, profile, bank)) {
        return { action: 'ask_human', ref: el.ref, question: el.label || 'Unlabelled field', options: el.options || [], reason: placeholder ? 'placeholder answer' : 'guessed factual answer' }
      }
    }
    if (checked !== action) return checked
  }
  if (action.action === 'type' && /[\r\n]/.test(action.value || '')) return { ...action, value: String(action.value).replace(/[\r\n]+/g, ' ') }
  if (action.action === 'press_key' && !KEYS.has(action.key)) return { action: 'invalid', reason: `Key ${action.key} is not allowed` }
  return el ? { ...action, ref: el.ref } : action
}

// ---- Commit gate -------------------------------------------------------------------------------------------

// Describes the element under a viewport point, piercing iframes and open shadow roots.
async function elementAt(page, obs, x, y) {
  let frame = page.mainFrame(), px = x, py = y
  for (let depth = 0; depth < 3; depth++) {
    const hit = await frame.evaluate(([x, y]) => {
      let el = document.elementFromPoint(x, y)
      while (el?.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner }
      if (!el) return null
      if (el.tagName === 'IFRAME') return { iframe: true }
      const ctl = el.closest('button,[role=button],input,a,[role=link],[data-agent-ref]') || el
      return { ref: ctl.getAttribute('data-agent-ref'), tag: ctl.tagName.toLowerCase(), type: ctl.type || ctl.getAttribute('role') || '', label: (ctl.getAttribute('aria-label') || ctl.innerText || ctl.value || '').replace(/\s+/g, ' ').trim().slice(0, 80) }
    }, [px, py]).catch(() => null)
    if (!hit?.iframe) return hit
    const handle = await frame.evaluateHandle(([x, y]) => document.elementFromPoint(x, y), [px, py])
    const inner = await handle.asElement()?.contentFrame()
    const box = await handle.asElement()?.boundingBox()
    if (!inner || !box) return { tag: 'iframe', label: '', type: '' }
    frame = inner; px -= box.x; py -= box.y
  }
  return null
}

// The focused element (deep), and whether pressing Enter there would submit its form.
async function focusInfo(page) {
  for (const frame of page.frames()) {
    const info = await frame.evaluate(() => {
      let el = document.activeElement
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
      if (!el || el === document.body || el.tagName === 'IFRAME') return null
      const form = el.form || el.closest('form')
      const textLike = el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file'].includes(el.type)
      const hasSubmit = !!form?.querySelector('button:not([type=button]):not([type=reset]),input[type=submit]')
      return { tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', ref: el.getAttribute('data-agent-ref'), label: (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 80), implicitSubmit: textLike && hasSubmit }
    }).catch(() => null)
    if (info) return info
  }
  return null
}

// True when running this action could submit the application.
export async function wouldCommit(env, action, el) {
  const { page, obs } = env
  switch (action.action) {
    case 'click': case 'check': return isSubmitControl(el, obs.elements, { text: obs.text })
    case 'click_at': {
      const hit = await elementAt(page, obs, Number(action.x), Number(action.y))
      const known = hit?.ref ? obs.elements.find(e => e.ref === hit.ref) : null
      return !!hit && isSubmitControl(known || hit, obs.elements, { text: obs.text })
    }
    case 'press_key': {
      if (!['Enter', 'Space'].includes(action.key)) return false
      const f = await focusInfo(page)
      if (!f) return false
      const known = f.ref ? obs.elements.find(e => e.ref === f.ref) : null
      if (isSubmitControl(known || f, obs.elements, { text: obs.text })) return true
      // Enter in a sign-in or code field sends that account form, not the application.
      return action.key === 'Enter' && f.implicitSubmit && obs.fieldCount >= 2 && !(accountPage(obs.elements) && !/submit (your|my|the|this) application/i.test(obs.text || ''))
    }
    case 'skill': return skillsFor(env.platform).find(s => s.name === action.name)?.risk === 'commit'
    default: return false
  }
}

// ---- Verification ------------------------------------------------------------------------------------------

async function pageProbe(page, obs) {
  const body = await page.mainFrame().evaluate(() => ({
    len: document.body?.innerText.length || 0, refs: document.querySelectorAll('[data-agent-ref]').length,
    fields: document.querySelectorAll('input:not([type=hidden]),select,textarea').length,
    headings: [...document.querySelectorAll('h1,h2,h3')].map(e => e.innerText).join('|'),
    dialogs: document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]').length,
    alerts: [...document.querySelectorAll('[role=alert],[class*=error]')].map(e => e.innerText).join('|').slice(0, 300),
  })).catch(() => ({}))
  return { url: page.url(), ...body, frames: obs.frames.length }
}

async function elProbe(obs, el) {
  if (!el) return null
  return locate(obs, el.ref).evaluate(n => ({
    value: n.tagName === 'SELECT' ? n.options[n.selectedIndex]?.text : n.type === 'file' ? [...(n.files || [])].map(f => f.name).join(',') : n.isContentEditable ? n.innerText : n.value ?? n.innerText,
    text: (n.innerText || '').slice(0, 200),
    checked: n.type === 'checkbox' || n.type === 'radio' ? n.checked : n.getAttribute('aria-checked') === 'true',
    expanded: n.getAttribute('aria-expanded'),
    invalid: n.getAttribute('aria-invalid'),
  }), null, { timeout: 2000 }).catch(() => null)
}

const pageChanged = (a, b) => a.url !== b.url || a.len !== b.len || a.refs !== b.refs || a.fields !== b.fields || a.dialogs !== b.dialogs || a.alerts !== b.alerts || a.headings !== b.headings

export function matchesValue(got, want) {
  const g = norm(got), w = norm(want)
  if (!w) return true
  if (g === w || g.includes(w)) return true
  const gd = digits(got), wd = digits(want)
  return wd.length >= 6 && gd.endsWith(wd.slice(-Math.min(10, wd.length)))
}

// ---- Actions -----------------------------------------------------------------------------------------------

// Custom dropdowns (Workday's country button, search prompts, React selects): open, pick the option if it is
// rendered, else search and pick a unique matching option. True only when the selection survives blur.
export async function chooseOption(page, loc, value) {
  const normalize = s => String(s).toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim()
  // B.Tech describes a bachelor's qualification, not a literal option on Greenhouse.
  const want = /^(b\.?\s*tech|bachelor of technology)(\b|,)/i.test(value) ? "Bachelor's Degree" : value
  const matches = text => {
    const got = normalize(text), v = normalize(want)
    return [v, normalize(value)].some(w => got === w || got.startsWith(w + ' ') || got.startsWith(w + ',') || got.startsWith(w + '+'))
  }
  // Whole lines only: question text containing "now" must never satisfy "No". A query is not a selection.
  const shows = async (chosen = want) => loc.evaluate((e, chosen) => {
    const normalize = s => String(s).toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim()
    const control = e.closest('.select__control')
    const selected = control?.querySelector('.select__single-value')
    const texts = selected ? [selected.innerText] : [`${e.innerText || ''}\n${e.getAttribute('role') === 'combobox' && e.tagName === 'INPUT' ? '' : e.value || ''}`]
    if (!control) for (let n = e.parentElement, i = 0; n && i < 4; n = n.parentElement, i++) {
      const t = (n.innerText || '').trim()
      if (t.length > 150) break
      texts.push(t)
    }
    const w = normalize(chosen)
    return texts.some(t => t.split('\n').some(line => {
      const g = normalize(line)
      // Greenhouse's phone-country selection displays just the dialing code.
      return g === w ||
        (e.id === 'country' && /^\+\d+$/.test(g) && w.endsWith(' ' + g))
    }))
  }, chosen).catch(() => false)
  if (await shows()) return true
  await loc.click({ timeout: 5000 })
  await page.waitForTimeout(400)
  // Stay in the control's document. aria-controls includes portalled menus without touching another field's list.
  const handle = await loc.elementHandle()
  const frame = await handle?.ownerFrame()
  await handle?.dispose()
  const scope = frame || page
  const menuId = await loc.getAttribute('aria-controls')
  const scopeOptions = menuId ? scope.locator(`[id="${menuId.replace(/"/g, '\\"')}"]`).locator('[role=option],.select__option') : scope.locator('[role=option],.select__option')
  const findOption = async () => {
    const offered = await scopeOptions.evaluateAll(nodes => nodes.map(e => {
      const r = e.getBoundingClientRect(), style = getComputedStyle(e)
      return { text: (e.innerText || '').trim(), visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' }
    }))
    const candidates = offered.filter(o => o.visible && matches(o.text)).map(o => ({ ...o, loc: scopeOptions.filter({ hasText: new RegExp(`^\\s*${escapeRe(o.text)}\\s*$`) }).first() }))
    const exact = candidates.filter(o => normalize(o.text) === normalize(value))
    const alias = candidates.filter(o => normalize(o.text) === normalize(want))
    return exact.length === 1 ? exact[0] : alias.length === 1 ? alias[0] : candidates.length === 1 ? candidates[0] : null
  }
  let option = await findOption()
  if (!option) {
    if (await loc.evaluate(e => e.tagName === 'INPUT')) await loc.fill(want)
    else await page.keyboard.type(want, { delay: 40 })
    for (let t = 0; t < 12 && !option; t++) {
      await page.waitForTimeout(500)
      option = await findOption()
    }
  }
  if (option) {
    const clicked = await option.loc.scrollIntoViewIfNeeded().then(() => option.loc.click({ timeout: 4000 })).then(() => true, () => false)
    if (clicked) {
      await loc.evaluate(e => e.blur())
      await page.waitForTimeout(400)
      if (await shows(option.text)) return true
      // Non-ARIA legacy selects can be keyboard-only; a sole matching visible option is safe.
      if (!await option.loc.getAttribute('role') && await loc.evaluate(e => e.tagName === 'INPUT')) {
        await loc.fill(want)
        await page.waitForTimeout(400)
        if (await scopeOptions.count() === 1 && matches(await scopeOptions.innerText())) {
          await page.keyboard.press('Enter')
          await loc.evaluate(e => e.blur())
          if (await shows(option.text)) return true
        }
      }
    }
  }
  await loc.press('Escape').catch(() => {})
  return false
}

const isCustomDropdown = el => el.tag !== 'select' && (el.role === 'combobox' || el.role === 'listbox' || (el.tag === 'button' && el.expanded !== undefined))

const DATE_FORMATS = {
  'yyyy-mm-dd': (y, m, d) => `${y}-${m}-${d}`, 'mm/dd/yyyy': (y, m, d) => `${m}/${d}/${y}`, 'dd/mm/yyyy': (y, m, d) => `${d}/${m}/${y}`,
  'dd-mm-yyyy': (y, m, d) => `${d}-${m}-${y}`, 'mm/yyyy': (y, m) => `${m}/${y}`, 'dd.mm.yyyy': (y, m, d) => `${d}.${m}.${y}`,
}
export function formatDate(iso, hint) {
  const [y, m, d] = String(iso).split('-')
  if (!y || !m) return iso
  const h = String(hint || '').toLowerCase().replace(/\s+/g, '')
  const key = Object.keys(DATE_FORMATS).find(k => h.includes(k)) || (/dd\/mm/.test(h) ? 'dd/mm/yyyy' : /mm\/dd/.test(h) ? 'mm/dd/yyyy' : 'mm/dd/yyyy')
  return DATE_FORMATS[key](y, m, d || '01')
}

async function setDate(env, el, loc, iso) {
  if (['month', 'day', 'year'].includes(el.date)) {
    const [year, month, day] = iso.split('-')
    await loc.fill(({ year, month, day })[el.date])
    await loc.press('Tab')
    return
  }
  if (el.date === 'native' || (await loc.getAttribute('type').catch(() => '')) === 'date') { await loc.fill(iso); return }
  const hint = `${await loc.getAttribute('placeholder').catch(() => '') || ''} ${el.label}`
  const readOnly = await loc.evaluate(n => n.readOnly).catch(() => false)
  if (!readOnly) {
    await loc.fill(formatDate(iso, hint)).catch(() => {})
    await env.page.keyboard.press('Tab').catch(() => {})
    if (matchesValue((await elProbe(env.obs, el))?.value, formatDate(iso, hint))) return
  }
  // Calendar: open it and click the day by its accessible name, paging months forward or back.
  const [y, m, d] = iso.split('-').map(Number)
  const long = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const names = [long, `${d} ${long.split(' ')[0]} ${y}`, iso]
  await loc.click()
  const frame = frameOf(env.obs, el.ref)
  for (let i = 0; i < 36; i++) {
    for (const name of names) {
      const day = frame.getByRole('button', { name: new RegExp(`^${escapeRe(name)}$`, 'i') }).or(frame.getByRole('gridcell', { name: new RegExp(`^${escapeRe(name)}$`, 'i') })).first()
      if (await day.isVisible().catch(() => false)) { await day.click(); return }
    }
    const shown = await frame.locator('[aria-live],[class*=month],[class*=caption]').first().innerText().catch(() => '')
    const shownDate = new Date(`${shown.match(/[A-Za-z]+ \d{4}/)?.[0] || ''} 1`)
    const forward = isNaN(shownDate) || shownDate < new Date(Date.UTC(y, m - 1, 1))
    const nav = frame.getByRole('button', { name: forward ? /next/i : /prev/i }).first()
    if (!await nav.isVisible().catch(() => false)) break
    await nav.click()
  }
  throw new Error('Could not find the date in the calendar')
}

async function resolveSecrets(env, missing) {
  const { ctx, obs, upload, profile } = env
  const domain = credentialDomain(new URL(obs.url).hostname)
  for (const key of ['PASSWORD', 'NEW_PASSWORD']) if (missing.includes(key)) ctx.secrets[key] = await accountSecret(ctx, domain, key)
  if (missing.includes('EMAIL') && !ctx.secrets.EMAIL) {
    // On an account form the login email is the saved one (creating the login if needed); elsewhere it is just the
    // job inbox address, and no login is created for a site that never asked for one.
    ctx.secrets.EMAIL = accountPage(obs.elements) ? await accountSecret(ctx, domain, 'EMAIL')
      : (await getCredential(ctx.db, domain).catch(() => null))?.username || process.env.JOB_GMAIL_ADDRESS || profile.email
  }
  if (missing.includes('COVER_LETTER')) ctx.secrets.COVER_LETTER = await upload('cover_letter_text')
  if (missing.includes('EMAIL_CODE') && !ctx.secrets.EMAIL_CODE) throw new Error('No email code read yet; use read_email first')
  if (missing.includes('SMS_CODE') && !ctx.secrets.SMS_CODE) {
    ctx.secrets.SMS_CODE = String(await ctx.ask({ kind: 'sms', prompt: 'Enter the SMS code the site just sent to your phone.', remember: false })).replace(/\D/g, '').slice(0, 10)
  }
}

// Verification emails often wrap the link in a click-tracking redirect on a host that is not on the allowlist.
// Follow those redirects without the browser (each hop must be a public host) until the link reaches an allowed host.
export async function followTracking(ctx, link, fetchFn = fetch) {
  let url = link
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Not a web link')
    if (isAllowedHost(u.hostname, ctx.job.application_url, ctx.allowedDomains)) return u.href
    await ctx.checkHost?.(u)
    const r = await fetchFn(u.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000) })
    const next = r.headers.get('location')
    if (!next || r.status < 300 || r.status >= 400) throw new Error(`The email link goes to ${u.hostname}, which is not on the allowlist`)
    url = new URL(next, u).href
  }
  throw new Error('The email link redirects too many times')
}

async function valueFor(env, a) {
  const { missing } = resolvePlaceholders(a.value ?? '', env.ctx.secrets)
  if (missing.length) await resolveSecrets(env, missing)
  return resolvePlaceholders(a.value ?? '', env.ctx.secrets).value
}

export async function clickEl(env, el, loc) {
  if (el.proxy === 'label') return loc.evaluate(n => n.labels[0].click())
  // A covering layer (Workday's click_filter) blocks the element itself; click its centre as a person would.
  return loc.click({ timeout: 5000 }).catch(async error => {
    const box = await loc.boundingBox().catch(() => null)
    if (!box) throw error
    await env.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  })
}

// Each run() returns a result: 'ok' | 'no_effect' | 'error:<why>' | 'stale' | special strings for the orchestrator.
function submitDiagnostic(ctx, event, detail) {
  const secrets = [...Object.values(ctx.secrets || {}), ...(ctx.secretValues?.() || [])]
  console.log('[submit]', event, redact(detail, secrets).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'))
}

function diagnosticUrl(url) {
  const safe = new URL(url)
  safe.username = ''; safe.password = ''; safe.search = ''; safe.hash = ''
  return safe.href
}

const RUN = {
  async fill(env, a, el, loc) {
    if (el.tag === 'select') return RUN.select(env, a, el, loc)
    if (isCustomDropdown(el)) return RUN.choose(env, a, el, loc)
    if (el.date && /^\d{4}-\d{2}(-\d{2})?$/.test(a.value || '')) return RUN.set_date(env, a, el, loc)
    const value = await valueFor(env, a)
    if (el.role === 'textbox' && el.tag !== 'input' && el.tag !== 'textarea') { await loc.click(); await env.page.keyboard.press('ControlOrMeta+A'); await env.page.keyboard.type(value) }
    else await loc.fill(value, { timeout: 5000 })
    if (el.type === 'password') return 'ok'
    const got = (await elProbe(env.obs, el))?.value
    if (matchesValue(got, value)) return 'ok'
    // Some fields reject fill() but accept typing.
    await loc.fill('').catch(() => {}); await loc.pressSequentially(value, { delay: 25 }).catch(() => {})
    return matchesValue((await elProbe(env.obs, el))?.value, value) ? 'ok' : `error:value did not stick (shows "${String(got ?? '').slice(0, 40)}")`
  },
  async select(env, a, el, loc) {
    const value = await valueFor(env, a)
    if (el.tag !== 'select') return RUN.choose(env, a, el, loc)
    const options = el.options || []
    const pick = options.find(o => norm(o) === norm(value)) || options.find(o => norm(o).startsWith(norm(value))) || options.find(o => norm(o).includes(norm(value)))
    await loc.selectOption(pick ? { label: pick } : value, { timeout: 4000 })
    return matchesValue((await elProbe(env.obs, el))?.value, pick || value) ? 'ok' : 'error:option not selected'
  },
  async choose(env, a, el, loc) {
    const value = await valueFor(env, a)
    if (el.tag === 'select') return RUN.select(env, a, el, loc)
    return await chooseOption(env.page, loc, value) ? 'ok' : `error:no option matching "${value}"`
  },
  async check(env, a, el, loc) {
    if (el.proxy === 'label' || !['checkbox', 'radio'].includes(el.type)) await clickEl(env, el, loc)
    else await loc.check({ timeout: 4000 }).catch(() => clickEl(env, el, loc))
    const p = await elProbe(env.obs, el)
    return p?.checked ? 'ok' : 'no_effect'
  },
  async click(env, a, el, loc) {
    await clickEl(env, el, loc)
    await env.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
    await env.page.waitForTimeout(300)
    return 'changed?'
  },
  async click_at(env, a) {
    const x = Number(a.x), y = Number(a.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'error:x and y are required'
    await env.page.mouse.click(x, y)
    await env.page.waitForTimeout(300)
    return 'changed?'
  },
  async type(env, a, el, loc) {
    // Typing into a dropdown's search box selects nothing; pick the matching option instead.
    if (isCustomDropdown(el)) return RUN.choose(env, a, el, loc)
    const value = await valueFor(env, a)
    await loc.click({ timeout: 4000 })
    await loc.pressSequentially(value, { delay: 45 })
    await env.page.waitForTimeout(500)
    return 'ok'
  },
  async press_key(env, a) {
    await env.page.keyboard.press(a.key === 'Space' ? ' ' : a.key)
    await env.page.waitForTimeout(250)
    return 'ok'
  },
  async hover(env, a, el, loc) { await loc.hover({ timeout: 4000 }); return 'ok' },
  async set_date(env, a, el, loc) {
    const iso = String(a.value || '')
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(iso)) return 'error:set_date needs value as YYYY-MM-DD'
    await setDate(env, el, loc, iso.length === 7 ? `${iso}-01` : iso)
    const got = (await elProbe(env.obs, el))?.value
    const part = { year: iso.slice(0, 4), month: iso.slice(5, 7), day: iso.slice(8, 10) || '01' }[el.date]
    return (part ? Number(got) === Number(part) : !!got) ? 'ok' : 'error:date did not stick'
  },
  async add_entry(env, a, el, loc) {
    const before = (await pageProbe(env.page, env.obs)).fields
    await clickEl(env, el, loc)
    await env.page.waitForTimeout(400)
    return (await pageProbe(env.page, env.obs)).fields > before ? 'ok' : 'no_effect'
  },
  async upload(env, a, el, loc) {
    const file = await env.upload(a.doc === 'cover_letter' ? 'cover_letter' : 'resume')
    if (el.file) await loc.setInputFiles(file, { timeout: 5000 })
    else {
      // A drop zone or "Attach" button: catch the file chooser it opens.
      const chooser = env.page.waitForEvent('filechooser', { timeout: 5000 })
      await clickEl(env, el, loc)
      await (await chooser).setFiles(file)
    }
    await env.page.waitForTimeout(500)
    const name = file.split('/').pop()
    const p = await elProbe(env.obs, el)
    const text = await env.page.locator('body').innerText().catch(() => '')
    return (p?.value && p.value.includes('.')) || text.includes(name) || /uploaded|attached|\.pdf/i.test(text) ? 'ok' : 'no_effect'
  },
  async scroll(env, a) { await env.page.mouse.wheel(0, a.direction === 'up' ? -700 : 700); await env.page.waitForTimeout(300); return 'ok' },
  async wait(env) { await env.page.waitForTimeout(2500); return 'ok' },
  async goto(env, a) { await env.ctx.gotoAllowed(a.url); return 'ok' },
  async read_email(env, a = {}) {
    // After a failed run the email may predate this run: look back to when the login was made, while unverified.
    const started = Date.now()
    let mail
    try {
      mail = await (env.ctx.mail?.waitForVerification || waitForVerification)({ domainHint: new URL(env.obs.url).hostname, since: await verificationSince(env.ctx, env.obs.url) })
    } catch (error) {
      if (a.codeRequired) submitDiagnostic(env.ctx, 'inbox', { result: 'error', elapsed_ms: Date.now() - started })
      throw error
    }
    if (a.codeRequired) submitDiagnostic(env.ctx, 'inbox', { result: mail?.code ? 'found' : 'none', code_length: mail?.code?.length || 0, elapsed_ms: Date.now() - started })
    if (!mail?.code && (!mail?.link || a.codeRequired || accountPage(env.obs.elements) === 'code')) {
      const code = await env.ctx.ask({ kind: 'sms', prompt: `Enter the email verification code sent to ${env.profile.email || 'your profile email'} for ${env.obs.url}`, remember: false })
      if (!String(code).trim()) return 'error:no verification code provided'
      env.ctx.secrets.EMAIL_CODE = String(code).trim()
      return 'ok'
    }
    if (mail.code) env.ctx.secrets.EMAIL_CODE = mail.code
    if (mail.link) env.ctx.emailLink = mail.link
    return 'ok'
  },
  async open_email_link(env) {
    if (!env.ctx.emailLink) return 'error:no verification link read yet'
    await env.ctx.gotoAllowed(await followTracking(env.ctx, env.ctx.emailLink))
    return 'ok'
  },
  async skill(env, a) {
    const skill = skillsFor(env.platform).find(s => s.name === a.name)
    if (!skill) return `error:no skill ${a.name} for ${env.platform}`
    const did = await skill.run(env, a.args || {})
    return did ? `ok:${did}` : 'no_effect'
  },
}

// ---- Dispatch ----------------------------------------------------------------------------------------------

/**
 * env: { page, ctx, obs, profile, bank, upload, mode, filled, shot, platform, submit(commitFn, info) }
 * Returns { action, result, el } where result is 'ok' | 'ok:<detail>' | 'no_effect' | 'error:<why>' | 'stale' |
 * 'dry_run_done' | 'submitted:<json>' | 'ask:<answer>' | 'finish'.
 */
export async function dispatch(env, raw, { enforced = false } = {}) {
  if (raw.action === 'batch') {
    const steps = (raw.actions || []).slice(0, 5)
    let last = { action: raw, result: 'ok' }
    for (const sub of steps) {
      last = await dispatch(env, sub)
      if (!last.result.startsWith('ok')) break
    }
    return last
  }
  const a = enforced ? raw : enforce(raw, env.obs, env)
  const el = ELEMENT_ACTIONS.has(a.action) ? findEl(env.obs, a) : null
  const { ctx } = env

  if (a.action === 'invalid') return { action: a, result: `error:${a.reason}` }
  if (a.action === 'hard_stop') {
    await ctx.notify(`Hard stop on ${ctx.job.application_url}: ${a.reason}`)
    throw new Stop('manual', a.reason)
  }
  if (a.action === 'finish') return { action: a, result: 'finish' }
  if (a.action === 'ask_human') {
    const prompt = a.question || 'The agent needs your input'
    const byRef = a.ref != null ? findEl(env.obs, a) : null
    const target = (byRef && isField(byRef) ? byRef : null) || env.obs.elements.find(e => e.label === a.question)
    // If this question parks the job, the resumed run puts the answer into the same field without the model (restore.mjs).
    ctx.pendingAsk = target ? { prompt, options: a.options || [], remember: a.remember !== false, label: target.label, ...restoreInfo(env, target, 'ask') } : null
    let answer
    try { answer = await ctx.ask({ prompt, options: a.options || [], photo: env.shot, remember: a.remember !== false }) } finally { ctx.pendingAsk = null }
    const picks = target ? groupPicks(env.obs.elements, target, answer) : []
    if (picks.length > 1 || (picks[0] && picks[0] !== target)) {
      let last = { result: 'ok' }
      for (const p of picks) last = await dispatch(env, { action: 'check', ref: p.ref }, { enforced: true })
      env.filled.push({ label: target.label, value: answer, confidence: 'high', source: 'user', ...restoreInfo(env, target, 'check') })
      return { action: a, result: last.result.startsWith('ok') ? 'ok:answered' : last.result, el: target }
    }
    if (target) {
      const action = target.tag === 'select' || isCustomDropdown(target) ? 'choose' : ['checkbox', 'radio'].includes(target.type) || ['checkbox', 'radio'].includes(target.role) ? 'check' : 'fill'
      const r = await dispatch(env, { action, ref: target.ref, value: answer }, { enforced: true })
      env.filled.push({ label: target.label, value: answer, confidence: 'high', source: 'user', ...restoreInfo(env, target, action) })
      return { action: a, result: r.result.startsWith('ok') ? `ok:answered` : r.result, el: target }
    }
    return { action: a, result: `ask:${answer}` }
  }

  if (el && !await stillSame(env.obs, el)) return { action: a, result: 'stale', el }

  // Anything that could submit goes through submit(): dry run stops, review asks you, the attempt is recorded first.
  if (await wouldCommit(env, a, el)) {
    const loc = el ? locate(env.obs, el.ref) : null
    const commit = a.action === 'click_at' ? () => env.page.mouse.click(Number(a.x), Number(a.y))
      : a.action === 'press_key' ? () => env.page.keyboard.press(a.key === 'Space' ? ' ' : a.key)
        : a.action === 'skill' ? () => RUN.skill(env, a)
          : () => clickEl(env, el, loc)
    return { action: a, result: await env.submit(commit, { label: el?.label, via: a.action }), el }
  }

  const loc = el ? locate(env.obs, el.ref) : null
  const accountBefore = accountPage(env.obs.elements)
  const before = await pageProbe(env.page, env.obs)
  const confirmedBefore = looksConfirmed(await env.page.locator('body').innerText().catch(() => ''), env.page.url())
  let result
  try {
    result = await RUN[a.action](env, a, el, loc)
  } catch (error) {
    if (error instanceof Stop) throw error
    if (error.dryRunBlock) { env.ctx.stage('account_wall'); throw new Stop('needs_user', error.message) }
    result = `error:${String(error.message).split('\n')[0].slice(0, 300)}`
  }
  if (result === 'changed?') result = pageChanged(before, await pageProbe(env.page, env.obs)) || (el && el.expanded !== undefined && String((await elProbe(env.obs, el))?.expanded) !== String(el.expanded)) ? 'ok' : 'no_effect'

  await tripwire(env, a, confirmedBefore)
  // Sent an account form (sign in, sign up, reset): read what the site said and keep the saved login in step.
  if (accountBefore && ['click', 'click_at', 'press_key', 'skill'].includes(a.action) && !result.startsWith('error')) {
    const told = await afterAccountAction(env, accountBefore, a, el)
    if (told) result = told
  }
  if (result.startsWith('ok') && el && VALUE_ACTIONS.has(a.action)) {
    // A ticked box is shown as "checked": its value attribute is an internal id (Greenhouse: 731172288), not an answer.
    const shown = el.type === 'password' ? '(password)' : a.action === 'check' ? 'checked' : String(a.value ?? '').replace(PLACEHOLDER, '($1)')
    env.filled.push({ label: el.label, value: shown, confidence: a.confidence || 'high', source: a.source || 'profile', ...restoreInfo(env, el, a.action) })
    if (a.confidence === 'medium') await ctx.flag(`Inferred: "${el.label}" = "${shown.slice(0, 60)}"`)
  }
  if (result.startsWith('ok') && el?.file && a.action === 'upload') {
    const doc = a.doc === 'cover_letter' ? 'cover_letter' : 'resume'
    env.filled.push({ label: el.label, value: doc === 'resume' ? 'resume' : 'cover letter', confidence: 'high', source: 'document', ...restoreInfo(env, el, 'upload'), doc })
  }
  return { action: a, result, el }
}

// Enough to put a value back after a park without asking the model again (restore.mjs): which action, which
// field (signature plus position among same-signature fields) and on which page.
function restoreInfo(env, el, action) {
  return { action, sig: fieldSig(el), pos: fieldPos(env.obs.elements, el), page: pageSignature(env.obs) }
}

// Invariant 9: a confirmation page after an action that did not go through submit() means something submitted
// behind the gate's back. Never retry, record it, and alert.
async function tripwire(env, a, confirmedBefore) {
  if (confirmedBefore) return
  const text = await env.page.locator('body').innerText().catch(() => '')
  if (!looksConfirmed(text, env.page.url())) return
  const { ctx } = env
  ctx.stats.safety_violations++
  await ctx.audit('tripwire', { action: a.action, ref: a.ref, url: env.page.url(), writes: ctx.writes?.sent?.slice(-5) })
  await ctx.step('tripwire', { action: a.action, label: a.ref, url: env.page.url() }, await screenshot(env.page, env.obs))
  if (env.mode === 'dry_run') throw new Stop('failed', `A confirmation page appeared after a ${a.action} that was not a submit. Dry run: nothing was sent.`)
  await ctx.db.query('UPDATE jobs SET submit_attempted_at = COALESCE(submit_attempted_at, now()) WHERE id=$1', [ctx.job.id])
  await ctx.notify(`Possible submit outside the approval gate on ${ctx.job.application_url} (after ${a.action}). Check it; it will not be retried.`)
  throw new Stop('submission_unverified', `A confirmation page appeared after ${a.action}, which was not the approved submit. Check manually; it will not be retried.`)
}

// Submit gate: dry run stops, review waits for approval, the attempt is recorded before the commit.
// A "check all that apply" group: the options an answer names (comma, semicolon or newline separated).
// Falls back to the target itself when it is not a checkbox or nothing matches.
export function groupPicks(elements, target, answer) {
  const isBox = e => e.type === 'checkbox' || e.role === 'checkbox'
  if (!isBox(target)) return [target]
  const group = target.label.includes(' >') ? target.label.split(' >')[0] : null
  const option = e => (group ? e.label.slice(group.length + 2) : e.label).trim().toLowerCase()
  const wanted = String(answer).split(/[,;\n]/).map(s => s.trim().toLowerCase()).filter(Boolean)
  const picks = elements.filter(e => isBox(e) && (!group || e.label.startsWith(group + ' >')) && wanted.some(w => option(e) === w || option(e).startsWith(w)))
  return picks.length ? picks : [target]
}

export function makeSubmit(env) {
  return async (commit, info = {}) => {
    const { page, ctx, obs, mode, filled, shot } = env
    const job = ctx.job
    ctx.stage('reached_submit')
    if (mode === 'dry_run') {
      await ctx.step('dry_run_stop', { reason: 'Reached submit; nothing sent', via: info.via, label: info.label, filled }, shot)
      return 'dry_run_done'
    }
    const host = new URL(obs.url).hostname
    if (!isAllowedHost(host, job.application_url, ctx.allowedDomains)) throw new Stop('manual', `Refusing to submit to ${host}, which is not on the allowlist`)
    if (mode === 'review') {
      const full = await page.screenshot({ fullPage: true, mask: obs.frames.map(f => f.locator('input[type=password]')) }).catch(() => shot)
      // Latest value per field, so a resumed run that refills the same values shows (and hashes) the same summary.
      const latest = [...new Map(filled.map(f => [f.label, f])).values()]
      const summary = latest.slice(-25).map(f => `• ${f.label}: ${String(f.value).slice(0, 60)}${f.confidence === 'medium' ? ' (inferred)' : ''}`).join('\n')
      // The approval is bound to exactly what you saw: after a resume, different content needs a new approval.
      const hash = createHash('sha256').update(JSON.stringify(latest.map(f => [f.label, String(f.value)]))).digest('hex').slice(0, 16)
      const answer = await ctx.ask({ kind: 'approval', prompt: `Ready to submit.\n${summary}${ctx.flags.length ? '\nFlags:\n' + ctx.flags.slice(-5).join('\n') : ''}`, options: ['Approve', 'Reject'], photo: full, remember: false, context: { hash } })
      if (answer !== 'Approve') throw new Stop('cancelled', 'You rejected the submission')
    }
    await ctx.heartbeat()
    // Record before the commit so an unclear result can never lead to a second submit.
    const claimed = await ctx.db.query('UPDATE jobs SET submit_attempted_at=now() WHERE id=$1 AND submit_attempted_at IS NULL RETURNING id', [job.id])
    if (!claimed.rowCount) throw new Stop('submission_unverified', 'A submit was already attempted')
    await ctx.audit('submit_attempt', { url: obs.url, via: info.via, values: filled.map(f => ({ label: f.label, value: f.value })) })

    let sent = false
    const onResponse = r => {
      const req = r.request()
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && r.status() < 400 && /^(application|multipart|text)/.test(req.headers()['content-type'] || '')) sent = true
    }
    page.on('response', onResponse)
    if (!await commit().then(() => true, () => false)) {
      await page.waitForTimeout(1500)
      page.off('response', onResponse)
      if (sent) throw new Stop('submission_unverified', 'The submit click errored after a request went out. Check manually; it will not be retried.')
      await ctx.db.query('UPDATE jobs SET submit_attempted_at=NULL WHERE id=$1', [job.id])
      await ctx.audit('submit_not_sent', { url: page.url(), reason: 'commit failed' })
      return 'error:the submit control could not be clicked'
    }
    let confirmed = false
    let challenged = false
    let initialPolls = 0
    let postVerifyUntil = null
    try {
      while (!confirmed && (postVerifyUntil ? Date.now() < postVerifyUntil : initialPolls < 10)) {
        if (!postVerifyUntil) initialPolls++
        await page.waitForTimeout(1500)
        confirmed = looksConfirmed(await page.locator('body').innerText().catch(() => ''), page.url())
        const challengeText = await page.locator('body').innerText().catch(() => '')
        const current = !confirmed && !challenged ? await observe(page) : null
        const challengeDetected = !confirmed && (/verification code|security code|enter (?:the |your )?8.character code/i.test(challengeText) || (current && accountPage(current.elements) === 'code'))
        submitDiagnostic(ctx, 'poll', { phase: postVerifyUntil ? 'post_verify' : 'post_submit', confirmed, challenge_detected: Boolean(challengeDetected) })
        if (current) {
          if (challengeDetected) {
            // Finish the challenge under the original approval and submit attempt, never submit the application again.
            challenged = true
            const codeEnv = { ...env, obs: current }
            const fields = current.elements.filter(e => isField(e) && ['text', 'tel', 'number', 'password'].includes(e.type))
            const inputs = await Promise.all(fields.map(async field => ({
              field, loc: locate(current, field.ref), ...await locate(current, field.ref).evaluate(n => ({
                single: n.maxLength === 1, verification: Boolean(n.closest('#email-verification, .email-verification')),
              })),
            })))
            const scoped = inputs.filter(input => input.verification)
            const candidates = scoped.length ? scoped : inputs
            const codeInputs = candidates.filter(({ field, single }) => single || /\b(code|otp|passcode|pin|digit)\b/i.test(field.label || ''))
            const buttons = current.elements.filter(e => /^(submit|verify|confirm|continue)(\b|$)/i.test(e.label || '') && (e.tag === 'button' || e.type === 'submit' || e.role === 'button'))
            submitDiagnostic(ctx, 'challenge', { box_count: codeInputs.length, field_count: fields.length, scoped: Boolean(scoped.length), button_count: buttons.length })
            let verified = false
            if (codeInputs.length && codeInputs.length === candidates.length && buttons.length === 1) {
              const read = await RUN.read_email(codeEnv, { codeRequired: true })
              const code = ctx.secrets.EMAIL_CODE
              if (read === 'ok' && code) {
                try {
                  if (codeInputs.length === 1 && !codeInputs[0].single) {
                    await codeInputs[0].loc.fill(code)
                  } else if (codeInputs.length === code.length && codeInputs.every(input => input.single)) {
                    for (const [i, input] of codeInputs.entries()) await input.loc.fill(code[i])
                  }
                  const entered = (await Promise.all(codeInputs.map(input => input.loc.inputValue()))).join('')
                  verified = entered === code
                  submitDiagnostic(ctx, 'fill', { result: verified ? 'matched' : 'mismatch', concatenated_length: entered.length, expected_length: code.length, length_matches: entered.length === code.length })
                } catch { submitDiagnostic(ctx, 'fill', { result: 'error' }) }
              }
            }
            if (verified) {
              await clickEl(codeEnv, buttons[0], locate(current, buttons[0].ref))
              submitDiagnostic(ctx, 'verify_clicked', { label: buttons[0].label })
            } else {
              submitDiagnostic(ctx, 'owner_assistance', { reason: 'unrecognized_or_unfilled_controls' })
              await ctx.ask({ kind: 'sms', prompt: `The email security-code controls on ${page.url()} could not be completed safely. Please complete the verification on the application page and reply when done.`, remember: false })
            }
            // Inbox/owner waits do not consume the confirmation window after verification.
            postVerifyUntil = Date.now() + 30000
            submitDiagnostic(ctx, 'confirmation_window', { timeout_ms: 30000 })
          }
        }
      }
    } finally {
      page.off('response', onResponse)
      const finalText = await page.locator('body').innerText().catch(() => '')
      const safeText = redact(finalText, Object.values(ctx.secrets || {})).slice(0, 200)
      submitDiagnostic(ctx, 'final', { confirmed, url: diagnosticUrl(page.url()), text: safeText })
    }
    const after = await screenshot(page, obs)
    const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 400)
    const key = await ctx.step('receipt', { confirmed, request_sent: sent, url: page.url() }, after)
    await ctx.db.query('UPDATE jobs SET receipt=$2 WHERE id=$1', [job.id, JSON.stringify({ url: page.url(), snippet: text, screenshot_key: key, at: new Date().toISOString() })])
    if (confirmed) { ctx.stage('submitted'); return 'submitted:' + JSON.stringify({ status: 'applied', note: 'Confirmation page captured' }) }
    if (sent || challenged) return 'submitted:' + JSON.stringify({ status: 'submission_unverified', note: 'A request was sent but no confirmation appeared. Check manually; it will not be retried.' })
    // Nothing was sent (for example validation errors), so allow a corrected retry.
    await ctx.db.query('UPDATE jobs SET submit_attempted_at=NULL WHERE id=$1', [job.id])
    await ctx.audit('submit_not_sent', { url: page.url() })
    return 'error:submit did not go through (validation errors?)'
  }
}

export { isField }
