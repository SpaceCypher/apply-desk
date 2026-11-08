// Answer keys for the engine scoreboard. Keys hold your answers, so they live in Neon (scoreboard_postings), and
// drafts go to scoreboard/keys/ (git-ignored) for you to correct.
//
//   node scoreboard/keys.mjs postings                 load scoreboard/postings.json (which postings are scored)
//   node scoreboard/keys.mjs draft [--platform lever] [--id 3] [--all] [--force]
//                                                     open each scored posting in dry run (no writes), list its
//                                                     questions, propose answers from your profile and answer bank.
//                                                     An existing key file is merged: your answers and skips stay.
//   node scoreboard/keys.mjs todo [--write]           unanswered questions across scored postings, each listed once;
//                                                     --write makes scoreboard/keys/answers.json to answer them in
//   node scoreboard/keys.mjs fill [scoreboard/keys/answers.json]
//                                                     copy those answers into every matching key file
//   node scoreboard/keys.mjs load [files]             store finished keys (default: all scored key files)
//   node scoreboard/keys.mjs show                     postings, key sizes, what is still unanswered
//
// --all includes spares (unscored postings). --force re-drafts postings whose key is already stored.
//
// Needs DATABASE_URL (your Neon database, read for the profile and answer bank) and Chrome (CHROMIUM_PATH or the
// installed Chrome channel).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import pg from 'pg'
import { chromium } from 'playwright'
import { createPolicy } from '../worker/lib/security.mjs'
import { installGuard, blockFormSubmit } from '../worker/lib/guard.mjs'
import { browserOptions } from '../worker/lib/browser.mjs'
import { looksClosed } from '../worker/lib/security.mjs'
import { openForm, questions, proposeKey, mergeKey, todoGroups, fillFromAnswers } from './lib.mjs'

// Behind BROWSER_PROXY the sandbox has no DNS of its own, so the public-address lookup cannot run; HTTPS and no raw
// IP addresses are still required, and the proxy is the only way out.
const proxiedPolicy = { async checkHost(u) { if (u.protocol !== 'https:' || isIP(u.hostname)) throw new Error('blocked host') } }

const [cmd, ...rest] = process.argv.slice(2)
const arg = name => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : null)
const dir = new URL('./keys/', import.meta.url)

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const readJson = async (u, fallback = null) => { try { return JSON.parse(await readFile(u, 'utf8')) } catch { return fallback } }
const fileFor = p => new URL(`${p.id}-${p.platform}.json`, dir)
// Scored postings (or all with --all), with their stored key.
const postingsWanted = async () => {
  const where = ['active']; const params = []
  if (!rest.includes('--all')) where.push('NOT spare')
  if (arg('platform')) { params.push(arg('platform')); where.push(`platform=$${params.length}`) }
  if (arg('id')) { params.push(Number(arg('id'))); where.push(`id=$${params.length}`) }
  return (await db.query(`SELECT id, platform, url, title, key FROM scoreboard_postings WHERE ${where.join(' AND ')} ORDER BY platform, id`, params)).rows
}
const keyFiles = async () => {
  const out = []
  for (const p of await postingsWanted()) { const k = await readJson(fileFor(p)); if (k) out.push(k) }
  return out
}
try {
  if (cmd === 'postings') {
    const all = JSON.parse(await readFile(new URL('./postings.json', import.meta.url), 'utf8'))
    let n = 0
    for (const [platform, list] of Object.entries(all)) {
      if (platform.startsWith('_')) continue
      for (const p of list) {
        await db.query(`INSERT INTO scoreboard_postings (platform, url, title, spare) VALUES ($1,$2,$3,$4)
          ON CONFLICT (url) DO UPDATE SET platform=EXCLUDED.platform, title=EXCLUDED.title, spare=EXCLUDED.spare, updated_at=now()`, [platform, p.url, p.title || null, !!p.spare])
        // "until": how far a posting is scored (Workday: up to the sign-in wall, no field key).
        await db.query(`UPDATE scoreboard_postings SET key = CASE WHEN $2::text IS NULL THEN key - 'until' ELSE jsonb_set(key, '{until}', to_jsonb($2::text)) END WHERE url=$1`, [p.url, p.until || null])
        n++
      }
    }
    const scored = (await db.query('SELECT id, platform, title FROM scoreboard_postings WHERE active AND NOT spare ORDER BY platform, id')).rows
    console.log(`${n} postings loaded. Scored:\n${scored.map(r => `  #${r.id} ${r.platform}: ${r.title}`).join('\n')}`)
  } else if (cmd === 'draft') {
    const postings = (await postingsWanted()).filter(p => rest.includes('--force') || !(p.key?.entries || []).length)
    const profile = (await db.query('SELECT fields FROM profile WHERE id=true')).rows[0]?.fields || {}
    const bank = (await db.query('SELECT question, answer FROM answer_bank')).rows
    await mkdir(dir, { recursive: true })
    // BROWSER_PROXY: only for sandboxes whose network goes through an intercepting proxy (local testing).
    const proxy = process.env.BROWSER_PROXY ? { proxy: { server: process.env.BROWSER_PROXY } } : {}
    const browser = await chromium.launch({ ...browserOptions(process.env.HEADLESS !== '0'), ...proxy })
    try {
      for (const p of postings) {
        if (p.key?.until === 'sign_in') { console.log(`${p.id} ${p.platform.padEnd(12)} scored up to the sign-in wall: no field key needed`); continue }
        const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US', ignoreHTTPSErrors: !!process.env.BROWSER_PROXY })
        // Dry run: every write is blocked and forms cannot submit.
        const writes = await installGuard(context, { policy: process.env.BROWSER_PROXY ? proxiedPolicy : createPolicy(), jobUrl: p.url, dryRun: true })
        const page = await context.newPage()
        await blockFormSubmit(page)
        let fresh = [], note = ''
        try {
          const obs = await openForm(page, p.url)
          if (looksClosed(obs.text, null)) note = 'posting looks closed: swap in a spare'
          else if (obs.elements.some(e => e.type === 'password')) note = 'account wall: only fields before sign-in can be keyed'
          fresh = proposeKey(questions(obs), profile, bank)
        } catch (error) { note = `could not open: ${error.message.split('\n')[0]}` }
        await context.close()
        const file = fileFor(p)
        const existing = await readJson(file, { entries: [] })
        // Never replace your answers with an empty draft when the page could not be read.
        const m = fresh.length ? mergeKey(existing, fresh) : { entries: existing.entries || [], orphans: existing.orphans || [], kept: (existing.entries || []).length, added: 0, refreshed: 0 }
        await writeFile(file, JSON.stringify({ id: p.id, platform: p.platform, url: p.url, title: p.title, note: note || undefined, entries: m.entries, ...(m.orphans.length ? { orphans: m.orphans } : {}) }, null, 2) + '\n')
        const todo = m.entries.filter(e => e.expected === null && !e.skip).length
        console.log(`${p.id} ${p.platform.padEnd(12)} ${String(m.entries.length).padStart(3)} questions: ${m.kept} kept, ${m.refreshed} refreshed, ${m.added} new, ${todo} unanswered${m.orphans.length ? `, ${m.orphans.length} orphaned answers (move them, see "orphans")` : ''}${note ? '  · ' + note : ''} (${writes.blocked} writes blocked)`)
      }
    } finally {
      await browser.close()
    }
    console.log('\nNext: node scoreboard/keys.mjs todo --write, answer each question once in scoreboard/keys/answers.json, then fill and load.')
  } else if (cmd === 'todo') {
    const groups = todoGroups(await keyFiles())
    if (!groups.length) console.log('Nothing unanswered on the scored postings.')
    for (const g of groups) console.log(`${g.required ? '*' : ' '} [${g.kind}] ${g.question}  (postings ${g.postings.map(id => '#' + id).join(', ')})${g.options?.length ? '\n      options: ' + g.options.slice(0, 12).join(' | ') : ''}`)
    if (rest.includes('--write')) {
      const file = new URL('answers.json', dir)
      const old = await readJson(file, [])
      const keep = new Map(old.filter(a => a.expected !== null && a.expected !== undefined || a.skip).map(a => [`${a.question}|${a.kind}`, a]))
      const rows = groups.map(g => keep.get(`${g.question}|${g.kind}`) || { question: g.question, kind: g.kind, required: g.required, postings: g.postings, ...(g.options ? { options: g.options } : {}), expected: null })
      await mkdir(dir, { recursive: true })
      await writeFile(file, JSON.stringify(rows, null, 2) + '\n')
      console.log(`\n${rows.length} questions written to scoreboard/keys/answers.json. Set each "expected" (text, an option, a list for checkboxes, {"regex": "..."}, or "skip": true), then: node scoreboard/keys.mjs fill`)
    }
  } else if (cmd === 'fill') {
    const answers = await readJson(rest[0] ? path.resolve(rest[0]) : new URL('answers.json', dir), [])
    let total = 0
    for (const p of await postingsWanted()) {
      const file = fileFor(p); const k = await readJson(file)
      if (!k) continue
      const n = fillFromAnswers([k], answers)
      if (n) { await writeFile(file, JSON.stringify(k, null, 2) + '\n'); total += n }
    }
    console.log(`${total} entries filled from your answers. Remaining: node scoreboard/keys.mjs todo`)
  } else if (cmd === 'load') {
    const files = rest.filter(f => !f.startsWith('--'))
    const keys = files.length ? await Promise.all(files.filter(f => !f.endsWith('answers.json')).map(f => readJson(path.resolve(f)))) : await keyFiles()
    for (const k of keys.filter(Boolean)) {
      const todo = k.entries.filter(e => (e.expected === null || e.expected === undefined) && !e.skip)
      if (todo.length) { console.log(`#${k.id}: ${todo.length} questions still unanswered (${todo.slice(0, 3).map(e => e.label).join('; ')}...). Answer them or mark "skip": true.`); continue }
      await db.query("UPDATE scoreboard_postings SET key = jsonb_set(key, '{entries}', $2::jsonb), updated_at=now() WHERE id=$1", [k.id, JSON.stringify(k.entries)])
      console.log(`#${k.id}: ${k.entries.length} entries stored${k.orphans?.length ? ` (${k.orphans.length} orphaned answers not stored)` : ''}`)
    }
  } else if (cmd === 'show') {
    const rows = (await db.query("SELECT id, platform, spare, active, title, key FROM scoreboard_postings ORDER BY spare, platform, id")).rows
    for (const r of rows) {
      const f = await readJson(fileFor(r))
      const open = f ? f.entries.filter(e => e.expected === null && !e.skip).length : null
      const what = r.key?.until === 'sign_in' ? 'scored up to sign-in' : `${(r.key?.entries || []).length} stored${f ? `, draft has ${open} unanswered` : ''}`
      console.log(`#${String(r.id).padEnd(3)} ${r.platform.padEnd(12)} ${r.spare ? 'spare ' : 'SCORED'} ${r.active ? '' : '(inactive) '}${what}  ${r.title || ''}`)
    }
  } else {
    console.log('Usage: node scoreboard/keys.mjs postings | draft [--platform p] [--id n] [--all] [--force] | todo [--write] | fill [answers.json] | load [files] | show')
  }
} finally {
  await db.end()
}
