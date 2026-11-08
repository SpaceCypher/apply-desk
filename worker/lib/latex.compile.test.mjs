// Compiles Jake's resume template with the real pdfLaTeX the worker uses. Skipped when pdflatex is not installed;
// CI's latex job installs the same TeX Live packages as apply.yml.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tailorLatex } from './latex.mjs'

const hasTex = (() => { try { execFileSync(process.env.PDFLATEX || 'pdflatex', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()
const TEX = readFileSync(new URL('./fixtures/jake-resume.tex', import.meta.url), 'utf8')
const gen = async ({ system }) => (system.includes('fact checker') ? { results: [] } : { include_summary: true, project_order: [], bullets: {} })

test('the template compiles to a one-page PDF, repairing the xcolor/color option clash', { skip: !hasTex && 'pdflatex not installed' }, async () => {
  const r = await tailorLatex({ resume_tex: TEX, email: 'jobs@example.test' }, { title: 'Engineer' }, { generateFn: gen })
  assert.equal(r.pdf.subarray(0, 4).toString(), '%PDF')
  assert.equal(r.pages, 1)
  assert.ok(r.tex.includes('jobs@example.test'))
})
