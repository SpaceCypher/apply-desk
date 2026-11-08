import { createHash } from 'node:crypto'

// Page walker. Runs inside each frame (main document, plus allowlisted iframes) and also descends into
// open shadow roots. Every interactive element gets data-agent-ref="<frame>:<n>" (main frame: just "<n>"),
// which Playwright CSS locators can find even inside shadow DOM.
function walker({ fi, max }) {
  const SEL = 'input,textarea,select,button,a[href],[contenteditable="true"],[role=button],[role=link],[role=combobox],[role=listbox],[role=option],[role=radio],[role=checkbox],[role=switch],[role=tab],[role=menuitem],[role=textbox],[role=spinbutton],[role=slider]'
  const vw = innerWidth, vh = innerHeight
  const text = el => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim()
  const visible = el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el)
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05
  }
  const byId = (root, id) => (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id)
  // The question a field belongs to when the page gives it no label of its own (Lever: a heading div beside the
  // field, options in a plain list). Climbs only while the container holds nothing but this field or its own option
  // group, so a neighbouring question's heading is never taken; option labels (<label> for a control) don't count.
  const FIELD_SEL = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]),select,textarea,[role=combobox],[role=textbox],[role=radio],[role=checkbox]'
  const HEADING_SEL = 'legend,[class*=label],[class*=question],h3,h4,h5,label'
  const questionText = el => {
    const name = el.getAttribute('name')
    const mine = f => f === el || (!!name && f.getAttribute('name') === name && f.type === el.type)
    for (let n = el.parentElement, d = 0; n && d < 6; n = n.parentElement, d++) {
      if ([...n.querySelectorAll(FIELD_SEL)].some(f => !mine(f))) return ''
      const h = [...n.querySelectorAll(HEADING_SEL)].find(x => !x.contains(el) && !x.querySelector(FIELD_SEL) && !(x.tagName === 'LABEL' && x.control) && text(x).trim())
      if (h) return text(h).replace(/[✱*]+/g, ' ').replace(/\s+/g, ' ').trim()
    }
    return ''
  }
  const labelOf = el => {
    const root = el.getRootNode()
    const parts = []
    if (el.labels) for (const l of el.labels) parts.push(text(l))
    const by = el.getAttribute('aria-labelledby')
    if (by) parts.push(by.split(/\s+/).map(id => text(byId(root, id))).join(' '))
    parts.push(el.getAttribute('aria-label') || '')
    const tag = el.tagName.toLowerCase(), role = el.getAttribute('role')
    if (['button', 'a'].includes(tag) || ['button', 'link', 'tab', 'menuitem', 'option', 'switch'].includes(role)) parts.push(text(el))
    const box = el.type === 'radio' || el.type === 'checkbox' || role === 'radio' || role === 'checkbox'
    // No label of its own: the question heading around it ("Current CTC"), before a placeholder like "Type your response".
    if (!box && !parts.join('').trim()) { const q = questionText(el); if (q) parts.push(q) }
    if (!parts.join('').trim()) parts.push(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '')
    if (box) {
      const wrap = el.closest('label'); if (wrap) parts.push(text(wrap))
      if (role && !parts.join('').trim()) parts.push(text(el))
      const group = el.closest('fieldset,[role=radiogroup],[role=group]')
      const legend = group && (group.querySelector('legend') || byId(root, group.getAttribute('aria-labelledby') || ''))
      if (legend) parts.unshift(text(legend) + ' >')
      else {
        // Options listed under a question heading without a fieldset (Lever): "<question> > <option>", like a legend.
        const q = questionText(el)
        if (q && !parts.some(p => p.includes(q))) parts.unshift(q + ' >')
      }
    }
    if (!parts.join('').trim()) {
      const near = el.closest('[class*=field],[class*=question],[class*=form-group],li,div')?.querySelector('label,legend,h3,h4,[class*=label]')
      if (near && near !== el) parts.push(text(near))
    }
    // Upload buttons are often only "Attach" or "Upload" (Greenhouse shows two of them): name the document from the
    // nearest heading-like label around the input, or from its id/name ("resume", "cover_letter").
    if (el.type === 'file') {
      const generic = t => !t.trim() || /^(attach|upload|browse|choose( a)? file|select( a)? file|add( a)? file|or|drop|enter manually|dropbox|google drive)\b[^]{0,40}$/i.test(t.trim())
      if (generic(parts.filter(Boolean).join(' '))) {
        for (let n = el.parentElement, d = 0; n && d < 5; n = n.parentElement, d++) {
          const l = [...n.querySelectorAll('label,legend,h3,h4,[class*=label]')].find(x => !x.contains(el) && !generic(text(x)))
          if (l) { parts.unshift(text(l)); break }
        }
        const hint = `${el.id || ''} ${el.name || ''}`.replace(/[_-]+/g, ' ').trim()
        if (/resume|\bcv\b|cover/i.test(hint) && !/resume|\bcv\b|cover/i.test(parts.join(' '))) parts.unshift(hint)
      }
    }
    return [...new Set(parts.filter(Boolean))].join(' ').slice(0, 300)
  }
  const sectionOf = el => {
    const fs = el.closest('fieldset'); if (fs?.querySelector('legend')) return text(fs.querySelector('legend')).slice(0, 80)
    let n = el
    for (let d = 0; d < 6 && n; d++) {
      n = n.parentElement || n.getRootNode()?.host
      const h = n?.querySelector?.(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > legend')
      if (h) return text(h).slice(0, 80)
    }
    return ''
  }
  const roleOf = el => {
    const r = el.getAttribute('role'); if (r) return r
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea' || el.isContentEditable) return 'textbox'
    if (tag === 'button') return ['listbox', 'true', 'menu', 'grid', 'tree'].includes(el.getAttribute('aria-haspopup')) ? 'combobox' : 'button'
    if (tag === 'input') return ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', file: 'file', range: 'slider', number: 'spinbutton', search: 'searchbox' })[el.type] || 'textbox'
    return tag
  }
  const errorOf = el => {
    const root = el.getRootNode()
    const ids = `${el.getAttribute('aria-describedby') || ''} ${el.getAttribute('aria-errormessage') || ''}`.trim()
    const described = ids ? ids.split(/\s+/).map(id => text(byId(root, id))).filter(Boolean).join(' ') : ''
    const sib = el.closest('[class*=field],[class*=question],[class*=form-group]')?.querySelector('[role=alert],[class*=error]:not(input)')
    const t = [described, sib && visible(sib) ? text(sib) : ''].filter(Boolean).join(' ')
    return /required|invalid|error|must|please|enter|select|choose|format/i.test(t) ? t.slice(0, 160) : ''
  }

  // Collect: light DOM plus open shadow roots, in document order.
  const found = []
  const walk = root => {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(SEL)) found.push(el)
      if (el.shadowRoot) walk(el.shadowRoot)
    }
  }
  walk(document)
  for (const el of document.querySelectorAll('[data-agent-ref]')) el.removeAttribute('data-agent-ref')
  const clearShadow = root => { for (const el of root.querySelectorAll('*')) { el.removeAttribute?.('data-agent-ref'); if (el.shadowRoot) clearShadow(el.shadowRoot) } }
  clearShadow(document)

  const out = []
  let n = 0
  for (const el of found) {
    if (out.length >= max * 3) break
    const tag = el.tagName.toLowerCase()
    if (el.type === 'hidden') continue
    const selectControl = el.getAttribute('role') === 'combobox' && el.closest('.select__control')
    const selectedValue = selectControl && selectControl.querySelector('.select__single-value')
    let proxy = null, rectEl = el
    if (!visible(el)) {
      // Hidden native radios/checkboxes styled through their label, and file inputs behind drop zones.
      if (selectControl && visible(selectControl)) { proxy = 'control'; rectEl = selectControl }
      else if ((el.type === 'radio' || el.type === 'checkbox') && el.labels?.[0] && visible(el.labels[0])) { proxy = 'label'; rectEl = el.labels[0] }
      else if (el.type === 'file') {
        const zone = el.closest('[class*=drop],[class*=upload],[class*=attach],label,div')
        proxy = 'dropzone'; rectEl = zone && visible(zone) ? zone : null
      } else continue
    }
    const r = rectEl ? rectEl.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 }
    const ref = fi === 0 ? String(n++) : `${fi}:${n++}`
    el.setAttribute('data-agent-ref', ref)
    const role = roleOf(el)
    const label = labelOf(el)
    el.setAttribute('data-agent-fp', `${tag}|${label.slice(0, 40)}`)
    const item = {
      ref, tag, type: el.type || role, role, label,
      form: el.form ? `${fi}:${[...document.forms].indexOf(el.form)}` : null,
      section: sectionOf(el),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      required: !!el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label),
      invalid: el.getAttribute('aria-invalid') === 'true',
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      inView: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
    }
    if (proxy) item.proxy = proxy
    const expanded = el.getAttribute('aria-expanded'); if (expanded !== null) item.expanded = expanded === 'true'
    if (el.getAttribute('aria-selected') !== null) item.selected = el.getAttribute('aria-selected') === 'true'
    if (el.type === 'password') item.value = el.value ? '(set)' : ''
    else if (tag === 'select') { item.value = el.selectedIndex > 0 || el.options[el.selectedIndex]?.value ? text(el.options[el.selectedIndex]) : ''; item.options = [...el.options].map(o => text(o)).slice(0, 80) }
    else if (selectControl) item.value = text(selectedValue).slice(0, 200)
    else if (tag === 'input' || tag === 'textarea') item.value = (el.type === 'file' ? [...(el.files || [])].map(f => f.name).join(', ') : el.value || '').slice(0, 200)
    else if (el.isContentEditable) item.value = text(el).slice(0, 200)
    else if (role === 'combobox' || (tag === 'button' && el.getAttribute('aria-haspopup'))) {
      const shown = text(el).slice(0, 120)
      // "Select...", "Choose one", "--" and the like are placeholders, not answers.
      item.value = /^(select|choose|pick|please (select|choose)|search|none selected|-{2,}|\.{3})\b|^(select|choose)\W*$/i.test(shown) ? '' : shown
    }
    if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked
    else if (['checkbox', 'radio', 'switch'].includes(role)) item.checked = el.getAttribute('aria-checked') === 'true'
    if (el.type === 'file') item.file = true
    if (tag === 'a') item.href = el.href
    if (el.type === 'date' || /date|dob|birth/i.test(label + (el.getAttribute('name') || ''))) item.date = el.type === 'date' ? 'native' : 'text'
    const datePart = (el.getAttribute('data-automation-id') || '').match(/^dateSection(Month|Day|Year)-input$/)?.[1]
    if (datePart) item.date = datePart.toLowerCase()
    const err = errorOf(el); if (err) item.error = err
    if (!item.label && tag === 'a') continue
    out.push(item)
  }
  const alerts = [...document.querySelectorAll('[role=alert],[aria-live=assertive],.error,.errors,[class*=error-message],[class*=errorMessage]')]
    .filter(visible).map(text).filter(Boolean).slice(0, 6)
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(visible).map(text).filter(Boolean).slice(0, 6)
  const body = text(document.body)
  const step = body.match(/(?:step|page)\s*(\d{1,2})\s*(?:of|\/)\s*(\d{1,2})/i)
  const bar = document.querySelector('[role=progressbar][aria-valuenow]')
  const progress = step ? `${step[1]}/${step[2]}` : bar ? `${bar.getAttribute('aria-valuenow')}/${bar.getAttribute('aria-valuemax') || 100}` : null
  const dialog = [...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].find(visible)
  const captcha = [...document.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],.cf-turnstile')]
    .some(f => visible(f) && !/size=invisible/.test(f.src || '') && f.getBoundingClientRect().height > 40)
  return {
    url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, fi === 0 ? 12000 : 3000),
    // AWS WAF can return an empty shell while its token POST is blocked in dry run.
    botBlocked: !(document.body?.innerText || '').trim() && !!document.querySelector('#challenge-container') && [...document.scripts].some(s => {
      try { const u = new URL(s.src); return u.hostname.endsWith('.token.awswaf.com') && /\/challenge\.js$/.test(u.pathname) } catch { return false }
    }),
    elements: out, alerts, headings, progress, captcha,
    modal: dialog ? (dialog.getAttribute('aria-label') || text(dialog.querySelector('h1,h2,h3')) || 'dialog').slice(0, 80) : null,
  }
}

const FILLABLE = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'checkbox', 'radio', 'file', 'switch'])
export const isField = e => FILLABLE.has(e.role) || ['input', 'textarea', 'select'].includes(e.tag)
const isEmpty = e => (e.checked === undefined ? !e.value : !e.checked)

/**
 * Observes the page: main frame plus same-origin or allowlisted iframes (frameFilter(url) decides).
 * Elements are ordered: unfilled required fields, then what is in view, then the rest; capped at max.
 * obs.frames (non-enumerable) maps frame index -> Playwright Frame for locate().
 */
export async function observe(page, { maxElements = 80, frameFilter = () => false } = {}) {
  const main = page.mainFrame()
  const frames = [main]
  for (const f of page.frames()) {
    if (f === main || f.isDetached()) continue
    let u; try { u = new URL(f.url()) } catch { continue }
    const sameOrigin = u.origin === new URL(main.url()).origin
    if (/^https?:$/.test(u.protocol) && (sameOrigin || frameFilter(u))) frames.push(f)
  }
  const parts = []
  for (let fi = 0; fi < frames.length; fi++) {
    const snap = await frames[fi].evaluate(walker, { fi, max: maxElements }).catch(() => null)
    if (!snap) continue
    if (fi > 0) {
      const box = await (await frames[fi].frameElement().catch(() => null))?.boundingBox().catch(() => null)
      if (!box) continue
      for (const e of snap.elements) { e.rect.x += Math.round(box.x); e.rect.y += Math.round(box.y); e.frame = fi }
    }
    parts.push(snap)
  }
  const top = parts[0] || { url: page.url(), title: '', text: '', elements: [], alerts: [], headings: [], progress: null, captcha: false, modal: null }
  const all = parts.flatMap(p => p.elements)
  const rank = e => (isField(e) && e.required && isEmpty(e) && !e.disabled ? 0 : e.inView ? 1 : 2)
  const elements = all.map((e, k) => [rank(e), k, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, maxElements).map(x => x[2])
  const obs = {
    url: top.url, title: top.title,
    text: [top.text, ...parts.slice(1).map(p => p.text)].join('\n').slice(0, 15000),
    elements,
    hidden: Math.max(0, all.length - elements.length),
    alerts: parts.flatMap(p => p.alerts).slice(0, 8),
    headings: top.headings, progress: parts.map(p => p.progress).find(Boolean) || null,
    modal: parts.map(p => p.modal).find(Boolean) || null,
    captcha: parts.some(p => p.captcha),
    botBlocked: parts.some(p => p.botBlocked),
    fieldCount: all.filter(isField).length,
  }
  Object.defineProperty(obs, 'frames', { value: frames, enumerable: false })
  return obs
}

export function frameOf(obs, ref) {
  const fi = String(ref).includes(':') ? Number(String(ref).split(':')[0]) : 0
  return obs.frames[fi] || obs.frames[0]
}

// The live locator for a ref, in the right frame (CSS pierces open shadow roots).
export function locate(obs, ref) {
  return frameOf(obs, ref).locator(`[data-agent-ref="${ref}"]`).first()
}

// Fingerprint check: the element at ref is still the one the planner saw (the walker wrote data-agent-fp).
// For buttons and links the live text is compared too, since a re-render can change it in place.
export async function stillSame(obs, el) {
  const now = await locate(obs, el.ref).evaluate(n => ({ fp: n.getAttribute('data-agent-fp'), text: (n.getAttribute('aria-label') || n.innerText || n.value || '').replace(/\s+/g, ' ').trim() }), null, { timeout: 1500 }).catch(() => null)
  if (!now || now.fp !== `${el.tag}|${el.label.slice(0, 40)}`) return false
  if (!['button', 'link', 'tab', 'menuitem', 'option'].includes(el.role) || !now.text) return true
  const a = now.text.toLowerCase().slice(0, 30), b = el.label.toLowerCase()
  return b.includes(a) || a.includes(b.slice(0, 30))
}

// A stable hash of what the user could change. Repeats mean the agent is looping.
export function stateHash(obs) {
  const parts = obs.elements.map(e => `${e.label}|${e.value ?? ''}|${e.checked ?? ''}|${e.expanded ?? ''}`)
  return createHash('sha1').update(obs.url + '\n' + (obs.modal || '') + '\n' + parts.join('\n') + obs.alerts.join('|')).digest('hex')
}

// Identifies "the same form page" across small edits: URL path, progress, headings and the set of field labels.
export function pageSignature(obs) {
  let path = ''; try { const u = new URL(obs.url); path = u.host + u.pathname } catch { /* ignore */ }
  const labels = obs.elements.filter(isField).map(e => e.label.slice(0, 40)).sort().join('|')
  return createHash('sha1').update([path, obs.progress || '', obs.headings.slice(0, 2).join('|'), labels].join('\n')).digest('hex').slice(0, 16)
}

const SUBMIT_LABEL = /^(submit( (my |your )?application)?|send( (my )?application)?|apply( now)?|finish( application)?|complete( (my )?application)?|confirm and submit|review and submit|submit and finish)$/i
// Common non-English submit words (German, French, Spanish, Italian, Portuguese, Dutch, Hindi).
const SUBMIT_INTL = /^(absenden|bewerbung (absenden|senden|einreichen)|jetzt bewerben|senden|einreichen|envoyer|soumettre|postuler|enviar( solicitud)?|postular|invia|candidati|enviar candidatura|candidatar-se|versturen|verzenden|solliciteer|सबमिट( करें)?|जमा करें|आवेदन (करें|भेजें))$/i
const NOT_FINAL = /next|continue|back|search|save|add|upload|verify|sign in|sign ?up|log ?in|create (an )?account|register|send (me )?(a |the )?(new )?(verification |login |one-time |reset |password reset |sign-in )?(code|link|email)|request (a )?(new )?(password|code|link)|resend|reset|forgot|weiter|zurück|suivant|siguiente|avanti|próximo|volgende|आगे/i
const STRONG_SUBMIT = /^(submit( (my |your )?application)?|send( (my )?application)?|submit and finish|confirm and submit|review and submit|submit now)$/i
// A control counts as the final submit when its label says so (no matter how few fields remain, e.g. a review
// page), or when an ambiguous label ("Apply", "Finish", a type=submit button) sits on a form.
export function isSubmitControl(el, elements, { text = '' } = {}) {
  if (!el || el.tag === 'a') return false
  const label = (el.label || '').replace(/\s+/g, ' ').trim()
  // A marketing page's unowned Apply dropdown must not borrow fields from search/alert forms. Ordinary
  // buttons outside a form stay conservative: JavaScript may submit an application form elsewhere.
  const scoped = el.form === null && el.tag === 'button' && el.role === 'combobox'
    ? elements.filter(e => e.form === null) : elements
  // Sign-up, sign-in, password-reset and one-time-code pages: their "Submit", "Sign up" or "Confirm" button sends
  // an account form, not the application. Never when the page itself talks about submitting the application.
  if (accountPage(scoped) && !APPLICATION_SUBMIT_TEXT.test(text.slice(0, 4000)) && !/application/i.test(label)) return false
  if (NOT_FINAL.test(label) && !STRONG_SUBMIT.test(label)) return false
  if (STRONG_SUBMIT.test(label) || SUBMIT_INTL.test(label)) return true
  const fields = scoped.filter(e => isField(e) && e !== el && !['submit', 'button', 'hidden'].includes(e.type)).length
  if (/^submit\b/i.test(label)) return fields >= 1
  if (SUBMIT_LABEL.test(label)) return fields >= 2
  return el.type === 'submit' && fields >= 1
}

// Account pages: a password or one-time-code field, nothing that belongs to an application (no file input, no
// resume or cover letter field) and at most 6 fields. Returns 'sign_up' | 'sign_in' | 'reset' | 'code' | null.
const APPLICATION_FIELD = /resume|\bcv\b|cover letter|curriculum|lebenslauf|portfolio|salary|work authori[sz]ation|sponsorship|years of experience/i
const CODE_FIELD = /\b(code|otp|passcode|pin|digit)\b/i
const NAME_FIELD = /\b(first|last|full|given|family|sur)\s*name\b|^name\b/i
const APPLICATION_SUBMIT_TEXT = /submit (your|my|the|this) application|review (your|my) application before|your application (is|will be) submitted/i
export function accountPage(elements) {
  const fields = elements.filter(e => isField(e) && !['submit', 'button', 'hidden', 'reset', 'image'].includes(e.type) && e.role !== 'button')
  if (!fields.length || fields.length > 6) return null
  if (fields.some(e => e.file || e.type === 'file' || APPLICATION_FIELD.test(e.label || ''))) return null
  const passwords = fields.filter(e => e.type === 'password').length
  const email = fields.some(e => e.type === 'email' || /e-?mail|user ?name|login id/i.test(e.label || ''))
  if (passwords >= 2) return email ? 'sign_up' : 'reset'
  if (passwords === 1) return fields.some(e => NAME_FIELD.test(e.label || '')) ? 'sign_up' : 'sign_in'
  if (fields.every(e => CODE_FIELD.test(e.label || '') || e.type === 'checkbox')) return 'code'
  return null
}

export const CONFIRMATION = /thank you for (applying|your application|submitting your application)|application (has been |was )?(submitted|received|sent)|successfully (submitted|applied)|we(?:'ve| have) received your application|your response has been recorded/i
export function looksConfirmed(text, url) {
  if (/verification code|security code|enter (?:the |your |an? )?(?:8.character |\d+.digit )?code/i.test(text)) return false
  return CONFIRMATION.test(text.slice(0, 6000)) || /\/(confirmation|submitted|thanks?|thank-you|formResponse)\b/i.test(url)
}

// Career sites often embed the real form (Greenhouse, Lever, Ashby, Typeform) in an iframe. Matches on the iframe's
// host: Google's proxy iframe on Greenhouse pages carries "greenhouse.io" in its query string and must not match.
const ATS_FRAME = /^https:\/\/([a-z0-9-]+\.)*(greenhouse\.io|lever\.co|ashbyhq\.com|typeform\.com)\//i
export const atsFrame = frames => (frames || []).find(src => ATS_FRAME.test(src)) || null
