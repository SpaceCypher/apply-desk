// Tailors the applicant's own LaTeX resume (Jake's template macros) by editing it in place:
// keep or drop or reword the summary, reorder or drop projects, reorder or reword bullets. Everything else is untouched.
// Rewritten text arrives as plain text and is always escaped, so neither the model nor a posting can inject LaTeX.
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { generate } from './gemini.mjs'
import { verifySupported } from './facts.mjs'
import { checkRewrites } from './documents.mjs'

// Index just past the brace that closes the one at `open`. Escaped braces (\{ \}) are skipped.
export function braceEnd(s, open) {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return i + 1
  }
  throw new Error('Unbalanced braces in the LaTeX template')
}

const MAP = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '&': '\\&', '#': '\\#', '$': '\\$', '_': '\\_', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}', '<': '\\textless{}', '>': '\\textgreater{}' }
const esc = s => s.replace(/[\\{}%&#$_~^<>]/g, c => MAP[c])
// Plain text with **bold** markers -> safe LaTeX.
export const toLatex = plain => String(plain).split(/\*\*(.+?)\*\*/).map((part, i) => (i % 2 ? `\\textbf{${esc(part)}}` : esc(part))).join('')

// LaTeX -> readable text for the model and the fact checker. Bold becomes **x** when `bold` is set.
export function toPlain(tex, { bold = false } = {}) {
  let s = tex.replace(/(?<!\\)%.*$/gm, '').replace(/\}\s*\{/g, '} {').replace(/\\href\{[^}]*\}/g, '')
  for (let prev; prev !== s;) {
    prev = s
    s = s.replace(/\\textbf\{([^{}]*)\}/g, bold ? '**$1**' : '$1').replace(/\\(?:emph|textit|underline|small)\{([^{}]*)\}/g, '$1')
  }
  return s.replace(/\$\|\$/g, '|').replace(/--/g, '–').replace(/\\\\/g, ' ').replace(/\\([%&#$_{}])/g, '$1')
    .replace(/\\[a-zA-Z]+\*?/g, '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
}

// Finds the summary, entry sections and their bullets as [start, end) offsets into the template.
export function parseResume(tex) {
  const docEnd = tex.indexOf('\\end{document}')
  if (docEnd < 0) throw new Error('No \\end{document} in the LaTeX template')
  const heads = [...tex.matchAll(/\\section\{([^}]*)\}/g)]
  const sections = heads.map((m, k) => ({ name: m[1], start: m.index, end: k + 1 < heads.length ? heads[k + 1].index : docEnd }))
  let summary = null
  const entrySections = []
  for (const sec of sections) {
    const body = tex.slice(sec.start, sec.end)
    if (/summary|profile|objective/i.test(sec.name)) {
      const m = /\\item\s*(?:\\small\s*)?([\s\S]*?)\s*\\end\{itemize\}/.exec(body)
      if (m) summary = { section: sec, start: sec.start + m.index + m[0].indexOf(m[1]), end: sec.start + m.index + m[0].indexOf(m[1]) + m[1].length }
      continue
    }
    const entries = []
    for (const h of body.matchAll(/\\resume(?:Subheading|ProjectHeading)\b/g)) {
      const start = sec.start + h.index
      const listEnd = tex.indexOf('\\resumeItemListEnd', start)
      if (listEnd < 0 || listEnd > sec.end) continue
      const end = listEnd + '\\resumeItemListEnd'.length
      const bullets = []
      for (let i = tex.indexOf('\\resumeItem{', start); i >= 0 && i < end; i = tex.indexOf('\\resumeItem{', i + 1)) {
        const open = i + '\\resumeItem'.length
        bullets.push({ start: open + 1, end: braceEnd(tex, open) - 1 })
      }
      const listStart = tex.indexOf('\\resumeItemListStart', start)
      entries.push({ start, end, heading: toPlain(tex.slice(start, listStart)), bullets })
    }
    if (entries.length) entrySections.push({ ...sec, projects: /project/i.test(sec.name), entries })
  }
  entrySections.forEach((sec, s) => sec.entries.forEach((e, i) => { e.id = `${sec.projects ? 'proj' : 'exp'}${s}_${i + 1}` }))
  return { summary, entrySections }
}

// Rebuilds the document from a checked plan: {include_summary, summary, project_order, bullets: {id: [{i, text}]}}.
export function renderResume(tex, parsed, plan, email) {
  const edits = [] // [start, end, replacement], applied back to front
  const { summary, entrySections } = parsed
  if (summary && plan.include_summary === false) edits.push([summary.section.start, summary.section.end, ''])
  else if (summary && plan.summary) edits.push([summary.start, summary.end, plan.summary])
  for (const sec of entrySections) {
    const entryText = e => {
      const order = plan.bullets?.[e.id] || []
      let out = tex.slice(e.start, e.end)
      // Fill bullet slots back to front so earlier offsets stay valid.
      for (let k = e.bullets.length - 1; k >= 0; k--) {
        const pick = order[k] || { i: k }
        const text = pick.text ?? tex.slice(e.bullets[pick.i].start, e.bullets[pick.i].end)
        out = out.slice(0, e.bullets[k].start - e.start) + text + out.slice(e.bullets[k].end - e.start)
      }
      return out
    }
    let ids = sec.entries.map(e => e.id)
    const byId = new Map(sec.entries.map(e => [e.id, e]))
    if (sec.projects && plan.project_order?.some(id => byId.has(id))) ids = plan.project_order.filter(id => byId.has(id))
    const chosen = ids.map(id => byId.get(id))
    // Gaps between entries (comments, spacing) stay in place; entries move through the slots.
    const first = sec.entries[0], last = sec.entries.at(-1)
    const gaps = sec.entries.slice(1).map((e, k) => tex.slice(sec.entries[k].end, e.start))
    const body = chosen.map((e, k) => entryText(e) + (k < chosen.length - 1 ? gaps[k] ?? '\n\n' : '')).join('')
    edits.push([first.start, last.end, body])
  }
  let out = tex
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + text + out.slice(end)
  const current = /mailto:([^}\s]+)/.exec(out)?.[1]
  if (email && current && current !== email) out = out.split(current).join(email)
  return out
}

// Turns the model's raw plan into a safe one: known ids only, every bullet index used once, rewrites fact-checked.
export async function checkPlan(tex, parsed, raw, { generateFn = generate } = {}) {
  const plan = { include_summary: raw.include_summary !== false, summary: null, project_order: [], bullets: {} }
  const projects = parsed.entrySections.filter(s => s.projects).flatMap(s => s.entries)
  const known = new Set(projects.map(e => e.id))
  plan.project_order = [...new Set((raw.project_order || []).map(String).filter(id => known.has(id)))]
  if (plan.project_order.length < Math.min(2, projects.length)) plan.project_order = projects.map(e => e.id)
  const pending = []
  for (const e of parsed.entrySections.flatMap(s => s.entries)) {
    const originals = e.bullets.map(b => tex.slice(b.start, b.end))
    const seen = new Set()
    const order = (raw.bullets?.[e.id] || []).filter(b => Number.isInteger(b?.i) && originals[b.i] !== undefined && !seen.has(b.i) && seen.add(b.i))
    for (let i = 0; i < originals.length; i++) if (!seen.has(i)) order.push({ i })
    plan.bullets[e.id] = order.map((b, k) => {
      const original = toPlain(originals[b.i])
      const text = typeof b.text === 'string' ? b.text.trim() : ''
      if (!text || text.replace(/\*\*/g, '') === original) return { i: b.i }
      if (!verifySupported(text.replace(/\*\*/g, ''), `${original} ${e.heading}`).ok) return { i: b.i }
      pending.push({ key: `${e.id}:${k}`, original, rewritten: text.replace(/\*\*/g, '') })
      return { i: b.i, text: toLatex(text), key: `${e.id}:${k}` }
    })
  }
  const whole = toPlain(tex.slice(tex.indexOf('\\begin{document}')))
  if (parsed.summary && plan.include_summary && typeof raw.summary === 'string' && raw.summary.trim()) {
    const text = raw.summary.trim().replace(/\*\*/g, '')
    if (verifySupported(text, whole).ok) {
      pending.push({ key: 'summary', original: whole, rewritten: text })
      plan.summary = toLatex(text)
    }
  }
  const verdicts = pending.length ? await checkRewrites(pending, generateFn) : {}
  if (plan.summary && !verdicts.summary) plan.summary = null
  for (const order of Object.values(plan.bullets)) for (const b of order) {
    if (b.key && !verdicts[b.key]) delete b.text
    delete b.key
  }
  return plan
}

// "Option clash for package P": P was loaded twice with different options (Jake's template loads xcolor, then
// color with options; Overleaf tolerates it, Ubuntu's TeX Live does not). Drop the later optioned loads and pass
// their options up front instead, so the first load already has them. Returns null when there is nothing to fix.
export function fixOptionClash(tex, message) {
  const pkg = /Option clash for package ([\w-]+)/.exec(message)?.[1]
  if (!pkg) return null
  const opts = []
  const re = new RegExp(String.raw`^[ \t]*\\usepackage\[([^\]]*)\]\{${pkg}\}[ \t]*\r?\n?`, 'gm')
  const out = tex.replace(re, (_, o) => { opts.push(...o.split(',').map(x => x.trim()).filter(Boolean)); return '' })
  if (!opts.length) return null
  const list = [...new Set(opts)].join(',')
  const targets = pkg === 'color' ? ['color', 'xcolor'] : [pkg] // xcolor stands in for color when both are loaded
  return targets.map(t => `\\PassOptionsToPackage{${list}}{${t}}\n`).join('') + out
}

// Compiles, repairing one package option clash if pdfLaTeX reports it.
async function compileRepaired(tex, compile) {
  try {
    return { ...(await compile(tex)), tex }
  } catch (error) {
    const fixed = fixOptionClash(tex, String(error.message))
    if (!fixed) throw error
    return { ...(await compile(fixed)), tex: fixed }
  }
}

export async function pdflatex(tex, { bin = process.env.PDFLATEX || 'pdflatex', timeout = 60000 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'resume-'))
  try {
    await writeFile(path.join(dir, 'resume.tex'), tex)
    // Like Overleaf: run past recoverable errors (a list without \item, a package option clash) and use the PDF
    // when one is produced. Those errors come back as warnings; only a run with no PDF fails.
    let failure = null
    await promisify(execFile)(bin, ['-interaction=nonstopmode', '-no-shell-escape', 'resume.tex'], { cwd: dir, timeout }).catch(error => { failure = error })
    const log = await readFile(path.join(dir, 'resume.log'), 'utf8').catch(() => failure?.message || '')
    const errors = log.split('\n').filter(l => l.startsWith('!')).map(l => l.slice(0, 160))
    const pdf = await readFile(path.join(dir, 'resume.pdf')).catch(() => null)
    if (!pdf) throw new Error(`pdflatex failed: ${errors.slice(0, 3).join(' ') || log.slice(-300)}`)
    const pages = Number(/Output written on .*?\((\d+) pages?/s.exec(log)?.[1] || 0)
    return { pdf, pages, warnings: [...new Set(errors)].slice(0, 5) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Plans with the model, checks the plan, then compiles. Over one page: drop the last project, then the summary.
export async function tailorLatex(profile, jd, { generateFn = generate, compile = pdflatex } = {}) {
  const tex = profile.resume_tex
  const parsed = parseResume(tex)
  const view = {
    summary: parsed.summary ? toPlain(tex.slice(parsed.summary.start, parsed.summary.end), { bold: true }) : null,
    sections: parsed.entrySections.map(s => ({ name: s.name, entries: s.entries.map(e => ({ id: e.id, heading: e.heading, bullets: e.bullets.map((b, i) => ({ i, text: toPlain(tex.slice(b.start, b.end), { bold: true }) })) })) })),
  }
  let raw = {}
  try {
    raw = await generateFn({
      system: 'You tailor an existing resume to one job. Use only facts already in the resume. Never add skills, tools, numbers, titles, dates or scope. Keep the applicant\'s tone and **bold** markers on key numbers.',
      prompt: `Job: ${JSON.stringify(jd)}\nResume: ${JSON.stringify(view)}\n` +
        'Decide: include_summary (true only if a summary helps for this role; reword it to the job\'s focus using only resume facts, or null to keep it as is); ' +
        'project_order (ids of the projects worth showing, most relevant first, at least 2); ' +
        'bullets per entry id, most relevant first, each {"i": original index, "text": reworded line or null to keep it}. Reword only to mirror the job\'s wording where it is true.\n' +
        'Return JSON {"include_summary":boolean,"summary":string|null,"project_order":[id],"bullets":{"<id>":[{"i":number,"text":string|null}]}}.',
    })
  } catch { /* the untailored template is still a good resume */ }
  const plan = await checkPlan(tex, parsed, raw || {}, { generateFn })
  for (;;) {
    const { pdf, pages, tex: out, warnings = [] } = await compileRepaired(renderResume(tex, parsed, plan, profile.email), compile)
    if (pages <= 1) return { pdf, tex: out, plan, pages, warnings }
    if (plan.project_order.length > 2) plan.project_order.pop()
    else if (parsed.summary && plan.include_summary) plan.include_summary = false
    else return { pdf, tex: out, plan, pages, warnings }
  }
}
