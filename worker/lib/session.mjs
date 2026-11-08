import { mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { isAllowedHost, scamFlags, createPolicy } from './security.mjs'
import { installGuard, blockFormSubmit } from './guard.mjs'
import { detectPlatform } from './platform.mjs'
import { createContext, Stop } from './context.mjs'
import { atsFrame } from './perception/walk.mjs'
import { runAgent } from './agent.mjs'
import { parseJobDescription, tailorResume, resumeHtml, htmlToPdf, writeCoverLetter, coverLetterHtml } from './documents.mjs'
import { tailorLatex } from './latex.mjs'
import { putBlob, getBlob } from './storage.mjs'
import { encrypt, decrypt, credentialDomain } from './vault.mjs'
import { browserOptions } from './browser.mjs'
import { waitForWorkday, workdayApplyUrl } from './workday.mjs'
import { loadLessons, scoreLessons, reflect, createMemory } from './lessons.mjs'
import { createMatcher } from './embeddings.mjs'
import { dispatch } from './actions/registry.mjs'

const FINAL = ['applied', 'failed', 'needs_user', 'submission_unverified', 'closed', 'cancelled', 'manual']
const LABEL = { applied: 'Applied', submission_unverified: 'Submitted, unverified', needs_user: 'Needs you', manual: 'Apply manually', closed: 'Job closed', cancelled: 'Cancelled', failed: 'Failed' }

/**
 * Runs one claimed job end to end and records the outcome. Shared by the production worker and the bench.
 * options.policy: URL policy (createPolicy()); only the bench passes one that allows loopback.
 * options.bench: { profile, bank, configure(ctx) } — synthetic persona, canned answers, quiet notifications.
 * Returns { status, note, stats }.
 */
export async function runJob({ db, job, workerId, settings, policy = createPolicy(), bench = null, resume = null }) {
  let browser, ctx, tmp
  const finish = async (status, note, { parked = false } = {}) => {
    if (parked) return { status, note, stats: ctx?.stats, parked: true }
    const final = FINAL.includes(status) ? status : 'failed'
    await db.query('UPDATE jobs SET checkpoint=NULL WHERE id=$1', [job.id]).catch(() => {})
    await db.query('UPDATE jobs SET status=$2, note=$3, cost=$5, updated_at=now() WHERE id=$1 AND claimed_by=$4',
      [job.id, final, note ?? null, workerId, JSON.stringify(ctx?.stats || {})]).catch(() =>
      db.query('UPDATE jobs SET status=$2, note=$3, updated_at=now() WHERE id=$1 AND claimed_by=$4', [job.id, final, note ?? null, workerId]))
    await ctx?.audit('finished', { status: final, note, stats: ctx?.stats })
    await ctx?.notify(`${LABEL[final]}: ${job.application_url}${note ? '\n' + note : ''}`)
    if (ctx?.learning) {
      // Learn from this run: credit the lessons that were in context, and reflect on what went wrong or needed recovery.
      await scoreLessons(db, ctx.learning.lessonIds, { status: final, stats: ctx.stats }).catch(() => {})
      if (!bench?.noReflect) await reflect({ db, ctx, history: ctx.history || [], platform: ctx.learning.platform, url: ctx.learning.url, profile: ctx.learning.profile }).catch(() => {})
    }
    return { status: final, note, stats: ctx?.stats }
  }
  try {
    if (settings.kill_switch === true) throw new Stop('cancelled', 'Kill switch engaged')
    ctx = createContext({ db, job, workerId, settings })
    ctx.allowedDomains = Array.isArray(settings.allowed_domains) ? settings.allowed_domains : []
    ctx.policy = policy
    bench?.configure?.(ctx)

    const url = new URL(job.application_url)
    policy.checkJobUrl(url)
    await policy.checkHost(url)
    const dryRun = job.mode === 'dry_run'

    const profile = bench?.profile || (await db.query('SELECT fields FROM profile WHERE id=true')).rows[0]?.fields || {}
    if (!profile.first_name || !profile.email) throw new Stop('needs_user', 'Fill in your profile (name and email) first')
    const bank = bench?.bank || (await db.query('SELECT question, answer, embedding, embedding_model FROM answer_bank')
      .catch(() => db.query('SELECT question, answer FROM answer_bank'))).rows

    // Persistent, encrypted browser state per employer site (never in the bench).
    const stateKey = `state/${credentialDomain(url.hostname)}.enc`
    let storageState = resume?.storageState
    if (!storageState && resume?.state_enc && process.env.VAULT_KEY) { try { storageState = JSON.parse(decrypt(resume.state_enc)) } catch { /* start fresh */ } }
    if (!storageState && !bench && process.env.VAULT_KEY) {
      const saved = await getBlob(db, stateKey).catch(() => null)
      if (saved) { try { storageState = JSON.parse(decrypt(saved.data.toString('utf8'))) } catch { /* stale state is ignored */ } }
    }

    browser = await chromium.launch({ ...browserOptions(process.env.HEADLESS === '1' || (!!bench && process.env.BENCH_HEADED !== '1')), args: ['--window-size=1366,900'] })
    const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, locale: 'en-US', timezoneId: 'Asia/Kolkata', storageState })
    ctx.writes = await installGuard(context, { policy, jobUrl: job.application_url, allowedDomains: () => ctx.allowedDomains, dryRun, allowUploads: !!bench?.allowUploads })
    const page = await context.newPage()
    context.on('page', async popup => {
      if (popup === page) return
      await popup.waitForLoadState('domcontentloaded').catch(() => {})
      const to = popup.url(); await popup.close().catch(() => {})
      if (/^https?:/.test(to)) await ctx.gotoAllowed(to).catch(() => {})
    })
    if (dryRun) await blockFormSubmit(page)

    ctx.checkHost = u => policy.checkHost(u)
    ctx.gotoAllowed = async to => {
      const u = new URL(to)
      if (!isAllowedHost(u.hostname, job.application_url, ctx.allowedDomains)) throw new Error(`Blocked navigation to ${u.hostname}`)
      await policy.checkHost(u)
      await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }
    // Park: when a question goes unanswered for a while, save where we are and free the runner. Your answer
    // re-queues the job (src/lib/jobs.ts answerQuestion) and the next run resumes here.
    if (!bench && process.env.PARK_ON_ASK !== '0') {
      ctx.parkAfterMs = Number(process.env.ASK_WAIT_SECONDS || 120) * 1000
      ctx.park = async kind => {
        const state = await context.storageState().catch(() => null)
        const checkpoint = { url: page.url(), state_enc: state && process.env.VAULT_KEY ? encrypt(JSON.stringify(state)) : null, kind, at: new Date().toISOString(), filled: (ctx.filled || []).slice(-80), pending: kind === 'question' ? ctx.pendingAsk || null : null }
        const status = kind === 'approval' ? 'awaiting_approval' : 'needs_user'
        await db.query('UPDATE jobs SET checkpoint=$2, status=$3, note=$4, cost=$5, claimed_by=NULL, lease_until=NULL, updated_at=now() WHERE id=$1 AND claimed_by=$6',
          [job.id, JSON.stringify(checkpoint), status, 'Waiting for your answer. The job resumes when you reply.', JSON.stringify(ctx.stats), workerId])
        await ctx.audit('parked', { kind, url: checkpoint.url })
        throw new Stop(status, 'Waiting for your answer. The job resumes when you reply.', { parked: true })
      }
    }
    ctx.saveState = async () => {
      if (bench || !process.env.VAULT_KEY) return null
      const state = await context.storageState().catch(() => null)
      if (state) await putBlob(db, stateKey, Buffer.from(encrypt(JSON.stringify(state))), 'text/plain').catch(() => {})
      return state
    }

    const start = resume?.url || url.href
    const response = await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(1500)
    if (detectPlatform(page.url()) === 'workday') await waitForWorkday(page)
    if (response && [404, 410].includes(response.status())) throw new Stop('closed', `Posting returned ${response.status()}`)
    // Embedded ATS boards live in iframes; open the frame directly when it is a known board. Optional: the agent also
    // reads allowlisted iframes in place, so a frame that cannot be opened is logged, not fatal.
    const frame = atsFrame(await page.evaluate(() => [...document.querySelectorAll('iframe')].map(f => f.src)).catch(() => []))
    if (frame && !resume) {
      await ctx.step('iframe_redirect', { frame })
      await ctx.gotoAllowed(frame).catch(error => ctx.step('iframe_redirect_failed', { frame, error: String(error.message).slice(0, 200) }))
    }

    const landingHtml = await page.content().catch(() => '')
    const workdayUrl = /phenom/i.test(landingHtml) ? workdayApplyUrl(landingHtml) : null
    if (workdayUrl && detectPlatform(page.url()) !== 'workday' && !resume) {
      await ctx.step('workday_redirect', { url: workdayUrl })
      await ctx.gotoAllowed(workdayUrl)
      await waitForWorkday(page)
    }

    const text = await page.locator('body').innerText().catch(() => '')
    const html = await page.content().catch(() => '')
    const platform = detectPlatform(page.url(), html)
    ctx.platform = platform
    const flags = scamFlags(text)
    for (const f of flags) await ctx.flag(`Scam signal: ${f}`)
    if (flags.length >= 2) {
      await ctx.notify(`Possible scam posting: ${job.application_url}\n${flags.join('; ')}`)
      throw new Stop('manual', `Looks like a scam: ${flags.join('; ')}`)
    }
    let jd = { title: job.title || '', company: job.company || '', must_have: [], keywords: [], seniority: '' }
    if (!resume) {
      try { jd = await parseJobDescription(text, ctx.meter) } catch (error) { await ctx.flag(`Could not parse the job description: ${error.message}`) }
      await db.query('UPDATE jobs SET platform=$2, job_description=$3, title=$4, company=$5 WHERE id=$1', [job.id, platform, text.slice(0, 30000), jd.title, jd.company])
    }
    await ctx.step(resume ? 'resumed' : 'opened', { platform, title: jd.title, company: jd.company, mode: job.mode })
    ctx.stage('opened')

    // Documents are produced only when a form asks for them.
    tmp = path.join(os.tmpdir(), `job-${job.id}`)
    await mkdir(tmp, { recursive: true })
    const made = {}
    const keepDocument = async (kind, pdf, content) => {
      const file = path.join(tmp, `${kind}.pdf`)
      await writeFile(file, pdf)
      const key = await putBlob(db, `jobs/${job.id}/${kind}.pdf`, pdf, 'application/pdf')
      await db.query('INSERT INTO documents (job_id, kind, blob_key, content) VALUES ($1,$2,$3,$4)', [job.id, kind, key, JSON.stringify(content)])
      return file
    }
    // A resumed run reuses the documents the parked run made. Generating them again costs model calls, and a resume
    // does not re-parse the job description, so a new resume would not be tailored.
    const kept = async kind => {
      if (!resume) return null
      const row = (await db.query('SELECT blob_key, content FROM documents WHERE job_id=$1 AND kind=$2 ORDER BY id DESC LIMIT 1',
        [job.id, kind === 'cover_letter_text' ? 'cover_letter' : kind]).catch(() => ({ rows: [] }))).rows[0]
      if (!row) return null
      if (kind === 'cover_letter_text') return row.content?.text || null
      const blob = await getBlob(db, row.blob_key).catch(() => null)
      if (!blob) return null
      const file = path.join(tmp, `${kind}.pdf`)
      await writeFile(file, blob.data)
      return file
    }
    const upload = bench?.upload || (async kind => {
      if (made[kind]) return made[kind]
      const reused = await kept(kind)
      if (reused) return (made[kind] = reused)
      let result
      if (kind === 'resume' && profile.resume_tex) {
        try {
          const r = await tailorLatex(profile, jd)
          if (r.pages > 1) await ctx.flag(`LaTeX resume is ${r.pages} pages even after trimming`)
          if (r.warnings?.length) await ctx.flag(`LaTeX resume compiled with recoverable errors (Overleaf shows these too): ${r.warnings.join(' ')}`)
          result = await keepDocument('resume', r.pdf, { source: 'latex', plan: r.plan, tex: r.tex })
        } catch (error) {
          await ctx.flag(`LaTeX resume failed, used the built-in layout: ${error.message}`)
        }
      }
      if (kind === 'resume') {
        if (!result) {
          const resumeDoc = await tailorResume(profile, jd)
          const pdf = await htmlToPdf(size => resumeHtml(profile, resumeDoc, size))
          result = await keepDocument('resume', pdf, resumeDoc)
        }
      } else {
        made.letter ??= await writeCoverLetter(profile, jd, text)
        if (kind === 'cover_letter_text') return (made[kind] = made.letter)
        const pdf = await htmlToPdf(size => coverLetterHtml(profile, made.letter, size), { fit: false })
        result = await keepDocument('cover_letter', pdf, { text: made.letter })
      }
      return (made[kind] = result)
    })

    const maxSteps = Number(settings.max_steps) || 150
    const lessons = await loadLessons(db, { platform, url: page.url(), mode: job.mode })
    const memory = bench?.noMemory ? null : createMemory(db, page.url(), dispatch)
    const matcher = createMatcher(db, bank)
    ctx.learning = { lessonIds: lessons.ids, platform, url: page.url(), profile }
    const result = await runAgent({ page, ctx, profile, bank, upload, platform, maxSteps, resume, lessons: lessons.text, memory, matcher })
    await ctx.saveState()
    return await finish(result.status, result.note)
  } catch (error) {
    const stop = error instanceof Stop ? error : new Stop('failed', error instanceof Error ? error.message : 'Run failed')
    if (!(error instanceof Stop)) console.error(error)
    // Keep the site's login session after a failure too, so a retry does not have to sign in (and fetch an email
    // code) again. A parked job keeps its session in the checkpoint instead.
    if (!stop.parked) await ctx?.saveState?.().catch(() => {})
    return await finish(stop.status, stop.note, { parked: stop.parked }).catch(() => ({ status: stop.status, note: stop.note, stats: ctx?.stats }))
  } finally {
    if (bench?.inspect && browser) for (const p of browser.contexts().flatMap(c => c.pages())) await bench.inspect(p).catch(() => {})
    await browser?.close().catch(() => {})
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}
