// Stagehand (v4) behind the scoreboard's engine interface.
//
// Stagehand runs inside the browser as an extension, driven over CDP. We keep everything that matters to safety
// and cost on our side:
// - the browser it uses has our network guard installed (Playwright routes on the same browser, via CDP);
// - every model call comes back to this process (Stagehand's client-side `generate`) and goes to Gemini on your
//   Vertex project through worker/lib/gemini.mjs, metered like the agent's;
// - the values come from your facts (profile, answer bank, then a question), never invented by Stagehand. Stagehand
//   finds the questions (extract) and operates the widgets (act), with each value passed as a variable.
import { existsSync } from 'node:fs'
import { localBrowser, Stagehand } from '@browserbasehq/stagehand'
import { z } from 'zod'
import { chromium } from 'playwright'
import { installGuard, blockFormSubmit } from '../lib/guard.mjs'
import { generateContent, FLASH, estimateCost } from '../lib/gemini.mjs'
import { profileField, profileValue } from '../fields.mjs'
import { findAnswer } from '../lib/answers.mjs'
import { sensitiveDecision } from '../lib/sensitive.mjs'
import { looksClosed } from '../lib/security.mjs'
import { openForm, cleanLabel } from '../../scoreboard/lib.mjs'
import { observe, locate } from '../lib/perception/walk.mjs'

export const name = 'stagehand'

// ---- Model bridge: Stagehand's llm.generate <-> Gemini (Vertex) -------------------------------------------

const asArray = c => (Array.isArray(c) ? c : [c])
function toParts(content) {
  return asArray(content).map(p => {
    if (p.type === 'text') return { text: p.text }
    if (p.type === 'image') return { inlineData: { mimeType: p.mimeType, data: p.data } }
    if (p.type === 'tool_use') return { functionCall: { name: p.name, args: p.input } }
    if (p.type === 'tool_result') return { text: `Tool result (${p.toolUseId}): ${asArray(p.content).map(c => c.text || '[image]').join('\n')}` }
    return { text: '' }
  })
}

export function stagehandModel({ meter, model = FLASH() } = {}) {
  let n = 0
  return {
    async generate(params) {
      const contents = params.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: toParts(m.content) }))
      const json = params.responseFormat?.type === 'json_schema'
      const config = {
        temperature: params.temperature ?? 0.1,
        ...(params.systemPrompt ? { systemInstruction: params.systemPrompt } : {}),
        ...(params.stopSequences?.length ? { stopSequences: params.stopSequences } : {}),
        ...(json ? { responseMimeType: 'application/json', responseJsonSchema: params.responseFormat.schema } : {}),
        ...(params.tools?.length ? {
          tools: [{ functionDeclarations: params.tools.map(t => ({ name: t.name, description: t.description || t.title || t.name, parametersJsonSchema: t.inputSchema })) }],
          ...(params.toolChoice?.mode ? { toolConfig: { functionCallingConfig: { mode: { required: 'ANY', auto: 'AUTO', none: 'NONE' }[params.toolChoice.mode] } } } : {}),
        } : {}),
      }
      const r = await generateContent({ model, contents, config, meter, kind: 'stagehand' })
      const usage = { inputTokens: r.usage.in, outputTokens: r.usage.out, totalTokens: r.usage.in + r.usage.out }
      if (json) {
        const text = r.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        return { role: 'assistant', content: [{ type: 'text', text }], outputFormat: 'json_schema', structuredContent: JSON.parse(text || '{}'), usage, stopReason: 'stop' }
      }
      const content = [...(r.text ? [{ type: 'text', text: r.text }] : []), ...r.functionCalls.map(c => ({ type: 'tool_use', id: `call_${++n}`, name: c.name, input: c.args || {} }))]
      return { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }], outputFormat: 'text', usage, stopReason: r.functionCalls.length ? 'tool_use' : 'stop' }
    },
  }
}

// ---- A Stagehand browser with our guard ---------------------------------------------------------------------

/**
 * Launches Chrome with the Stagehand extension, attaches Playwright to the same browser over CDP and installs our
 * guard on its context, then creates Stagehand with model calls routed back here.
 * Returns { stagehand, page, writes, close }.
 */
export async function launchGuarded({ jobUrl, policy, dryRun = true, allowUploads = false, allowedDomains = [], blockSubmitEvent = true, generate }) {
  const sb = await localBrowser.launch({
    // CHROMIUM_PATH locally; on the Actions runner, its preinstalled Google Chrome.
    ...(process.env.CHROMIUM_PATH || existsSync('/usr/bin/google-chrome') ? { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/google-chrome' } : {}),
    headless: process.env.BENCH_HEADED !== '1',
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
  })
  let pw
  try {
    pw = await chromium.connectOverCDP(sb.cdpUrl)
    const context = pw.contexts()[0]
    const writes = await installGuard(context, { policy, jobUrl, allowedDomains, dryRun, allowUploads })
    const page = context.pages().find(p => !p.url().startsWith('chrome-extension://')) || await context.newPage()
    if (blockSubmitEvent) await blockFormSubmit(page)
    const stagehand = await Stagehand.create({ browser: sb, model: { generate }, logging: { level: 'warn' } })
    return {
      stagehand, page, writes,
      async close() {
        await stagehand.close().catch(() => {})
        await pw.close().catch(() => {})
        await sb.close().catch(() => {})
      },
    }
  } catch (error) {
    await pw?.close().catch(() => {})
    await sb.close().catch(() => {})
    throw error
  }
}

// ---- Filling ------------------------------------------------------------------------------------------------

// The résumé's file input: labelled résumé/CV, never an "Autofill from resume" helper (Ashby shows one first).
export async function resumeInput(page) {
  const obs = await observe(page, { maxElements: 300 })
  const files = obs.elements.filter(e => e.file || e.type === 'file')
  const about = e => `${e.label || ''} ${e.section || ''}`
  const pick = files.find(e => /resume|\bcv\b|curriculum/i.test(about(e)) && !/autofill|parse/i.test(about(e))) || files.find(e => !/autofill|parse/i.test(about(e)))
  return pick ? locate(obs, pick.ref) : null
}

async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    const el = page.locator(sel).first()
    if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 8000 }).catch(() => {}); return true }
  }
  return false
}

const QUESTIONS = z.object({
  questions: z.array(z.object({
    label: z.string().describe('the question or field label exactly as shown, without the required asterisk'),
    kind: z.enum(['text', 'textarea', 'select', 'combobox', 'radio', 'checkbox', 'checkbox_group', 'file', 'date']),
    required: z.boolean(),
    options: z.array(z.string()).optional().describe('visible option texts for select, radio and checkbox groups'),
  })),
})

// Your answer for a question, from the same sources the agent uses: sensitive rules, profile, answer bank.
export function factFor(label, profile, bank) {
  const clean = cleanLabel(label)
  const sens = sensitiveDecision(clean, profile)
  if (sens) return sens.action === 'answer' ? sens.value : null
  const field = profileField(clean)
  const v = field ? profileValue(profile, field) : ''
  if (v) return v
  return findAnswer(clean, bank, 0.6)?.answer || null
}

function instructionFor(q) {
  const where = `the "${cleanLabel(q.label)}" field of the application form`
  switch (q.kind) {
    case 'select': case 'combobox': return `select %value% in ${where} (open it, type to filter if needed, and pick the matching option)`
    case 'radio': return `choose the %value% option for ${where}`
    case 'checkbox_group': return `tick the options %value% in ${where}`
    case 'checkbox': return `tick ${where}`
    case 'date': return `enter the date %value% in ${where}`
    default: return `type %value% into ${where}`
  }
}

/**
 * fill({ url, profile, bank, settings, policy, resumePdf, ask, score }) -> { status, note, stage, stats, writes, steps }
 * Dry run only: it never clicks the final submit, and the guard blocks any write except a résumé upload to known
 * ATS storage.
 */
export async function fill({ url, profile, bank, settings, policy, resumePdf, ask, score }) {
  const stats = { model_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0, questions: 0, stage: 'opened' }
  const meter = { add(model, i, o) { stats.model_calls++; stats.tokens_in += i; stats.tokens_out += o; stats.cost += estimateCost(model, i, o) } }
  let steps = 0, note = '', g
  try {
    g = await launchGuarded({ jobUrl: url, policy, dryRun: true, allowUploads: true, allowedDomains: settings.allowed_domains || [], generate: stagehandModel({ meter }).generate })
    // Same start as the agent: the posting, its Apply button or embedded board form (scoreboard/lib.mjs openForm).
    let obs = await openForm(g.page, url)
    // Not on a form yet (Workday: Apply, then Apply Manually): let Stagehand start the application, twice at most.
    for (let i = 0; i < 4 && obs.fieldCount < 3 && !obs.elements.some(e => e.type === 'password'); i++) {
      steps++
      // Workday's own start buttons first (the same ids the agent's Workday skill uses), then Stagehand.
      if (!await clickFirst(g.page, ['[data-automation-id="applyManually"]', '[data-automation-id="adventureButton"]']))
        await g.stagehand.act('click the button that starts the job application (for example Apply, Apply Now or Apply Manually); never a button that submits an application', { timeout: 30000 }).catch(() => {})
      await g.page.waitForLoadState('domcontentloaded').catch(() => {})
      await g.page.waitForTimeout(2500)
      obs = await observe(g.page, { maxElements: 300 })
    }
    if (looksClosed(obs.text, null)) return { status: 'closed', note: 'posting closed', stage: stats.stage, stats, writes: g.writes.log, steps }
    if (obs.elements.some(e => e.type === 'password')) {
      stats.stage = 'account_wall'
      return { status: 'needs_user', note: 'account wall (dry runs never sign in)', stage: stats.stage, stats, writes: g.writes.log, steps }
    }
    stats.stage = 'apply_clicked'

    const { data } = await g.stagehand.extract('List every question of the job application form that the applicant must answer or may answer: each text field, dropdown, radio group, checkbox group, single checkbox and file upload. Skip buttons and links.', QUESTIONS)
    steps++
    const qs = data.questions || []
    if (qs.length) stats.stage = 'form_page'
    for (const q of qs) {
      steps++
      try {
        if (q.kind === 'file') {
          if (!/resume|\bcv\b|curriculum/i.test(q.label) || /autofill|parse/i.test(q.label)) continue
          const input = await resumeInput(g.page)
          if (input) await input.setInputFiles(resumePdf, { timeout: 8000 })
          continue
        }
        let value = factFor(q.label, profile, bank)
        if (!value && q.kind !== 'checkbox') {
          if (!q.required) continue
          stats.questions++
          value = await ask({ prompt: cleanLabel(q.label), options: q.options || [] })
        }
        if (q.kind === 'checkbox' && !value) continue
        await g.stagehand.act(instructionFor(q), { variables: { value: String(value ?? '') }, timeout: 30000 })
      } catch (error) {
        note = `${note}${note ? '; ' : ''}${cleanLabel(q.label).slice(0, 40)}: ${String(error.message).split('\n')[0].slice(0, 80)}`.slice(0, 400)
      }
    }
    // Every question was tried; the final submit is deliberately not clicked (dry run).
    if (qs.length) stats.stage = 'reached_submit'
    await score?.(g.page)
    return { status: 'needs_user', note: note || `filled ${qs.length} questions`, stage: stats.stage, stats, writes: g.writes.log, steps }
  } catch (error) {
    if (g) await score?.(g.page).catch(() => {})
    return { status: 'failed', note: String(error.message).split('\n')[0].slice(0, 300), stage: stats.stage, stats, writes: g?.writes.log || [], steps }
  } finally {
    await g?.close()
  }
}
