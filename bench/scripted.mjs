// Deterministic stand-in for Gemini, used by tests and fixture runs. It reads the same JSON payload the agent
// sends and answers with simple rules: profile and canned answers by label, required fields first, then
// Next/Submit. It exists to exercise perception, actions, the gate and recovery, not to judge intelligence.
const SYN = [
  [/^(first name|given name|vorname|prénom|nombre)\b/i, p => p.first_name],
  [/^(last name|surname|family name|nachname|nom|apellido)\b/i, p => p.last_name],
  [/^(full name|name|your name)\b/i, p => `${p.first_name} ${p.last_name}`],
  [/(e-?mail)/i, p => p.email],
  [/(phone|telefon|mobile|téléphone)(?! country)/i, p => p.phone],
  [/linkedin/i, p => p.linkedin],
  [/github/i, p => p.github],
  [/^(city|location|stadt|ort|ville)\b/i, p => (p.location || '').split(',')[0]],
  [/(company|employer|arbeitgeber)/i, (p, n) => p.experiences?.[n]?.company],
  [/(job title|title|position)/i, (p, n) => p.experiences?.[n]?.title],
  [/^(start date|from)\s*\*?$/i, (p, n) => p.experiences?.[n]?.start],
  [/(date of birth|birth ?date|geburtsdatum)/i, p => p.birth_date],
]

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9À-ɏऀ-ॿ ]+/g, ' ').replace(/\s+/g, ' ').trim()

function answerFor(label, profile, answers, nth = 0) {
  const clean = String(label || '').replace(/\*/g, '').trim()
  for (const [re, get] of SYN) if (re.test(clean)) { const v = get(profile, nth); if (v) return { value: v, source: 'profile' } }
  const n = norm(clean.split('>').pop())
  const hit = answers.find(a => norm(a.question) === n || n.includes(norm(a.question)) || norm(a.question).includes(n))
  return hit && n ? { value: hit.answer, source: 'answer_bank' } : null
}

function actionFor(f, ans) {
  if (f.file) return { action: 'upload', ref: f.ref, doc: /cover/i.test(f.label) ? 'cover_letter' : 'resume', source: 'document', confidence: 'high' }
  if (!ans) return null
  if (f.date || /^\d{4}-\d{2}(-\d{2})?$/.test(ans.value)) {
    const iso = /^\d{4}-\d{2}$/.test(ans.value) ? `${ans.value}-01` : ans.value
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { action: 'set_date', ref: f.ref, value: iso, source: ans.source, confidence: 'high' }
  }
  if (f.role === 'combobox' || f.role === 'listbox') return { action: f.options ? 'select' : 'choose', ref: f.ref, value: ans.value, source: ans.source, confidence: 'high' }
  return { action: 'fill', ref: f.ref, value: ans.value, source: ans.source, confidence: 'high' }
}

// Radio/checkbox groups: "Group > Option" labels. Pick the option whose text matches the answer.
function radioPick(fields, profile, answers) {
  const groups = {}
  for (const f of fields) if ((f.role === 'radio' || f.type === 'radio') && f.label.includes('>')) (groups[f.label.split('>')[0].trim()] ??= []).push(f)
  const out = []
  for (const [group, opts] of Object.entries(groups)) {
    if (opts.some(o => o.checked)) continue
    const ans = answerFor(group, profile, answers)
    const pick = ans && opts.find(o => norm(o.label.split('>').pop()) === norm(ans.value))
    if (pick) out.push({ action: 'check', ref: pick.ref, source: ans.source, confidence: 'high', reason: group })
  }
  return out
}

export function scriptedPlanner({ profile, answers }) {
  const calls = []
  const backend = async ({ prompt, kind }) => {
    calls.push(kind)
    const json = JSON.parse(prompt.slice(0, prompt.indexOf('\n<untrusted_page>') > 0 ? prompt.indexOf('\n<untrusted_page>') : undefined))
    const usage = { in: Math.ceil(prompt.length / 4), out: 60 }
    if (kind === 'parse_jd') return { text: JSON.stringify({ title: 'Bench role', company: 'Bench', must_have: [], keywords: [], seniority: 'entry' }), usage }
    if (kind === 'reflect') return { text: JSON.stringify({ lessons: [] }), usage }
    if (kind === 'plan') {
      const rows = []
      const seenLabel = {}
      for (const f of json.fields) {
        const base = norm(f.label); const nth = seenLabel[base] = (seenLabel[base] ?? -1) + 1
        if (f.value || f.checked || f.role === 'radio' || f.type === 'radio' || f.role === 'checkbox') continue
        const a = actionFor(f, answerFor(f.label, profile, answers, nth))
        if (a) rows.push(a)
      }
      rows.push(...radioPick(json.fields, profile, answers))
      return { text: JSON.stringify({ rows }), usage }
    }
    // step / recover
    const els = json.elements
    const recent = json.recent_actions || []
    const failedRefs = new Set(recent.filter(r => !String(r.result).startsWith('ok')).map(r => r.ref))
    const button = re => els.find(e => (e.role === 'button' || e.role === 'link') && re.test(e.label) && !e.disabled && !failedRefs.has(e.ref))
    if (json.page.modal) {
      const close = button(/^(close|dismiss|got it|accept( all)?|ok|×|x)$/i)
      if (close) return { text: JSON.stringify({ action: 'click', ref: close.ref, reason: 'close the dialog' }), usage }
      if (kind === 'recover') return { text: JSON.stringify({ action: 'press_key', key: 'Escape', reason: 'close the dialog' }), usage }
    }
    for (const r of radioPick(els, profile, answers)) return { text: JSON.stringify(r), usage }
    const experienceBlocks = els.filter(e => /company|employer/i.test(e.label)).length
    const add = button(/add (another|more)|\+ ?add/i)
    if (add && experienceBlocks && experienceBlocks < (profile.experiences || []).length && !recent.some(r => r.action === 'add_entry' && r.ref === add.ref && experienceBlocks > 1))
      return { text: JSON.stringify({ action: 'add_entry', ref: add.ref, reason: 'second experience' }), usage }
    const empty = els.filter(e => (e.required || e.error || e.invalid) && !e.value && e.checked !== true && !['button', 'link'].includes(e.role) && !failedRefs.has(e.ref))
    for (const f of empty) {
      const a = actionFor(f, answerFor(f.label, profile, answers))
      if (a) return { text: JSON.stringify({ ...a, reason: 'required field' }), usage }
      if (!f.file && f.role !== 'radio') return { text: JSON.stringify({ action: 'ask_human', ref: f.ref, question: f.label, options: [], reason: 'no fact' }), usage }
    }
    const upload = els.find(e => e.file && !e.value)
    if (upload) return { text: JSON.stringify({ action: 'upload', ref: upload.ref, doc: 'resume', reason: 'resume' }), usage }
    const next = button(/^(submit( application)?|absenden|send application|apply|finish)$/i) || button(/^(next|continue|weiter|save and continue|review)$/i) || button(/^(apply( now| for this job)?)$/i)
    if (next) return { text: JSON.stringify({ action: 'click', ref: next.ref, reason: 'advance' }), usage }
    if (kind === 'recover') {
      const any = button(/submit|next|continue|absenden/i)
      if (any?.box) return { text: JSON.stringify({ action: 'click_at', x: any.box[0] + Math.round(any.box[2] / 2), y: any.box[1] + Math.round(any.box[3] / 2), reason: 'recover' }), usage }
    }
    if (json.page.more_elements_below) return { text: JSON.stringify({ action: 'scroll', direction: 'down', reason: 'more below' }), usage }
    return { text: JSON.stringify({ action: 'finish', result: 'blocked', note: 'scripted planner has nothing to do' }), usage }
  }
  backend.calls = calls
  return backend
}
