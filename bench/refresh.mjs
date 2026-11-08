// Picks one fresh, open posting per board for the live bench. Uses public job-listing APIs (read-only
// queries; nothing is applied to). Writes bench/live.json. Boards without an API use their seed URLs.
// Usage: node bench/refresh.mjs [--only greenhouse,lever]
import { readFile, writeFile } from 'node:fs/promises'

const boards = JSON.parse(await readFile(new URL('./boards.json', import.meta.url), 'utf8'))
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null
const get = async (url, init) => {
  const r = await fetch(url, { ...init, headers: { 'user-agent': 'apply-desk-bench/1.0', ...(init?.headers || {}) }, signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.json()
}
const pick = list => list[Math.floor(Math.random() * Math.min(list.length, 20))]

const DISCOVER = {
  async greenhouse(slug) { const d = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`); const j = pick(d.jobs || []); return j && `https://job-boards.greenhouse.io/${slug}/jobs/${j.id}` },
  async lever(slug) { const d = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`); const j = pick(d || []); return j && `${j.hostedUrl}/apply` },
  async ashby(slug) { const d = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`); const j = pick((d.jobs || []).filter(x => x.isListed !== false)); return j && (j.applyUrl || `${j.jobUrl}/application`) },
  async smartrecruiters(slug) { const d = await get(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=20`); const j = pick(d.content || []); return j && `https://jobs.smartrecruiters.com/${slug}/${j.id}` },
  async workday([tenant, wd, site]) {
    const base = `https://${tenant}.${wd}.myworkdayjobs.com`
    const d = await get(`${base}/wday/cxs/${tenant}/${site}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }) })
    const j = pick(d.jobPostings || []); return j && `${base}/en-US/${site}${j.externalPath}`
  },
  async workable(slug) {
    const d = await get(`https://apply.workable.com/api/v3/accounts/${slug}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '', location: [], department: [], worktype: [], remote: [] }) })
    const j = pick(d.results || []); return j && `https://apply.workable.com/${slug}/j/${j.shortcode}/apply/`
  },
  async bamboohr(slug) { const d = await get(`https://${slug}.bamboohr.com/careers/list`, { headers: { accept: 'application/json' } }); const j = pick(d.result || []); return j && `https://${slug}.bamboohr.com/careers/${j.id}` },
}

const out = []
for (const [board, cfg] of Object.entries(boards)) {
  if (board.startsWith('_') || (only && !only.includes(board))) continue
  const d = cfg.discover || {}
  let url = null, error = null
  try {
    if (d.api) {
      for (const slug of [...(d.boards || d.sites || [])].sort(() => Math.random() - 0.5)) {
        url = await DISCOVER[d.api](slug).catch(e => { error = e.message; return null })
        if (url) break
      }
    } else if (d.seeds?.length) url = pick(d.seeds)
    else error = 'no seed URL configured (add one to bench/boards.json)'
  } catch (e) { error = e.message }
  out.push({ board, url, expect: cfg.expect, handoff: !!cfg.handoff, ...(url ? {} : { skipped: error }) })
  console.log(`${board.padEnd(16)} ${url || `skipped: ${error}`}`)
}
await writeFile(new URL('./live.json', import.meta.url), JSON.stringify(out, null, 2))
