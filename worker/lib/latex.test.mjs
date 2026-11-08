import test from 'node:test'
import assert from 'node:assert/strict'
import { parseResume, renderResume, checkPlan, tailorLatex, toLatex, toPlain } from './latex.mjs'

const TEX = String.raw`\documentclass{article}
\begin{document}
\begin{center}\href{mailto:old@example.com}{\underline{old@example.com}}\end{center}
%-----------SUMMARY-----------
\section{Summary}
\begin{itemize}[leftmargin=0.15in, label={}]
    \item \small Applied AI engineer building RAG pipelines on AWS.
\end{itemize}
%-----------EXPERIENCE-----------
\section{Experience}
\resumeSubHeadingListStart
\resumeSubheading
{Software Engineering Intern}{June 2025 -- July 2025}
{Acme}{Remote}
\resumeItemListStart
    \resumeItem{Built semantic search with OpenAI embeddings, \textbf{40\%} more relevant.}
    \resumeItem{Built \textbf{Node.js/MongoDB} REST APIs; cut integration time \textbf{35\%}.}
\resumeItemListEnd
\resumeSubHeadingListEnd
\section{Projects}
\resumeSubHeadingListStart
%---A---
\resumeProjectHeading
{\textbf{Alpha Q\&A} $|$ \emph{Lambda, SQS}}{Sep 2026}
\resumeItemListStart
    \resumeItem{Alpha bullet one with SQS.}
\resumeItemListEnd
%---B---
\resumeProjectHeading
{\textbf{Beta} $|$ \emph{PyTorch}}{Apr 2026}
\resumeItemListStart
    \resumeItem{Beta bullet with PyTorch, \textbf{68\% EM}.}
\resumeItemListEnd
%---C---
\resumeProjectHeading
{\textbf{Gamma} $|$ \emph{React}}{Oct 2026}
\resumeItemListStart
    \resumeItem{Gamma bullet with React.}
\resumeItemListEnd
\resumeSubHeadingListEnd
\section{Achievements}
\resumeItemListStart
    \resumeItem{5th place at a hackathon.}
\resumeItemListEnd
\end{document}
`
const parsed = parseResume(TEX)
const ids = parsed.entrySections.find(s => s.projects).entries.map(e => e.id)
const expId = parsed.entrySections[0].entries[0].id
const approve = async ({ prompt }) => ({ results: [...prompt.matchAll(/"key":"([^"]+)"/g)].map(m => ({ key: m[1], supported: true })) })

test('parses summary, entries and bullets; achievements are not entries', () => {
  assert.equal(toPlain(TEX.slice(parsed.summary.start, parsed.summary.end)), 'Applied AI engineer building RAG pipelines on AWS.')
  assert.deepEqual(parsed.entrySections.map(s => [s.name, s.entries.length]), [['Experience', 1], ['Projects', 3]])
  assert.equal(parsed.entrySections[0].entries[0].bullets.length, 2)
  assert.match(parsed.entrySections[1].entries[0].heading, /Alpha Q&A \| Lambda, SQS/)
})

test('an empty plan reproduces the template exactly, apart from the email', () => {
  const out = renderResume(TEX, parsed, { project_order: [], bullets: {} }, 'new@example.net')
  assert.equal(out, TEX.split('old@example.com').join('new@example.net'))
  assert.equal(renderResume(TEX, parsed, {}, ''), TEX)
})

test('drops the summary, reorders and drops projects, reorders bullets', () => {
  const out = renderResume(TEX, parsed, { include_summary: false, project_order: [ids[2], ids[0]], bullets: { [expId]: [{ i: 1 }, { i: 0 }] } })
  assert.ok(!out.includes('\\section{Summary}') && !out.includes('Applied AI engineer'))
  assert.ok(out.indexOf('Gamma bullet') < out.indexOf('Alpha bullet') && !out.includes('Beta bullet'))
  assert.ok(out.indexOf('Node.js/MongoDB') < out.indexOf('semantic search'))
  assert.ok(out.includes('5th place at a hackathon.'))
})

test('escaping: special characters and injected commands stay text', () => {
  assert.equal(toLatex('cut cost **40%** & time_x'), 'cut cost \\textbf{40\\%} \\& time\\_x')
  assert.equal(toLatex('\\input{/etc/passwd}'), '\\textbackslash{}input\\{/etc/passwd\\}')
})

test('checkPlan keeps supported rewrites, reverts invented ones, ignores unknown ids', async () => {
  const raw = {
    project_order: ['nope', ids[1]],
    bullets: { [expId]: [
      { i: 1, text: 'Shipped **Node.js/MongoDB** REST APIs; cut integration time **35%**.' },
      { i: 0, text: 'Built semantic search with Kubernetes, **90%** more relevant.' },
    ] },
    summary: 'Applied AI engineer building RAG pipelines on AWS with PyTorch.',
  }
  const plan = await checkPlan(TEX, parsed, raw, { generateFn: approve })
  assert.deepEqual(plan.project_order, ids, 'fewer than 2 valid ids falls back to all projects')
  assert.equal(plan.bullets[expId][0].text, 'Shipped \\textbf{Node.js/MongoDB} REST APIs; cut integration time \\textbf{35\\%}.')
  assert.equal(plan.bullets[expId][1].text, undefined, 'invented tool and number revert to the original')
  assert.equal(plan.summary, 'Applied AI engineer building RAG pipelines on AWS with PyTorch.')
  const rejected = await checkPlan(TEX, parsed, raw, { generateFn: async () => ({ results: [] }) })
  assert.equal(rejected.bullets[expId][0].text, undefined, 'an unverified rewrite is dropped')
  assert.equal(rejected.summary, null)
})

test('tailorLatex trims projects, then the summary, until one page', async () => {
  const pagesFor = tex => (tex.match(/resumeProjectHeading/g) || []).length + (tex.includes('section{Summary}') ? 1 : 0) - 1
  const seen = []
  const compile = async tex => { seen.push(pagesFor(tex)); return { pdf: Buffer.from('pdf'), pages: pagesFor(tex) } }
  const gen = async ({ system }) => (system.includes('fact checker') ? { results: [] } : { include_summary: true, project_order: ids, bullets: {} })
  const r = await tailorLatex({ resume_tex: TEX, email: 'new@example.net' }, { title: 'x' }, { generateFn: gen, compile })
  assert.deepEqual(seen, [3, 2, 1])
  assert.equal(r.pages, 1)
  assert.ok(!r.tex.includes('section{Summary}') && r.tex.includes('new@example.net'))
})

test('a failed planner call still yields the untouched template', async () => {
  const r = await tailorLatex({ resume_tex: TEX }, {}, { generateFn: async () => { throw new Error('quota') }, compile: async () => ({ pdf: Buffer.from(''), pages: 1 }) })
  assert.equal(r.tex, TEX)
})
