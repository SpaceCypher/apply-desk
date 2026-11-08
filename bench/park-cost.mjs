// Park-and-resume cost on a Greenhouse-shaped page: run 1 parks at a question, run 2 parks at approval,
// run 3 submits. Counts model calls (by kind) and tokens per run with a scripted backend, plus resume PDFs made.
// Scripted model (no Vertex needed), a scratch database (never production: it cancels queued jobs).
// Usage: node bench/park-cost.mjs [repo dir, to measure another checkout]   (needs DATABASE_URL, CHROMIUM_PATH)
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const repo = path.resolve(process.argv[2] || new URL('..', import.meta.url).pathname)
const pg = createRequire(path.join(repo, 'package.json'))('pg')
const { runJob } = await import(path.join(repo, 'worker/lib/session.mjs'))
const { createPolicy } = await import(path.join(repo, 'worker/lib/security.mjs'))
const { setModelBackend } = await import(path.join(repo, 'worker/lib/gemini.mjs'))

const Q = `Years of Zig ${Date.now().toString(36)}`
const FORM = `<!doctype html><title>Apply</title><body><h1>Apply for Intern</h1><form action="/submit" method="post">
<label for="fn">First name *</label><input id="fn" required>
<label for="ln">Last name *</label><input id="ln" required>
<label for="em">Email *</label><input id="em" type="email" required>
<label id="cl">Country *</label>
<div id="country" role="combobox" tabindex="0" aria-labelledby="cl" aria-expanded="false" aria-required="true" style="border:1px solid #888;padding:6px">Select...</div>
<ul id="lb" role="listbox" hidden></ul>
<fieldset><legend>Languages you use</legend><label><input type="checkbox" name="l" value="731172288"> Python</label><label><input type="checkbox" name="l" value="731172289"> Go</label></fieldset>
<label for="cv">Resume *</label><input id="cv" type="file" required>
<label for="q">${Q} *</label><input id="q" required>
<button type="submit">Submit application</button></form>
<script>
const C=['Germany','India','Ireland'];let open=false,typed='';
const render=()=>{lb.innerHTML=C.filter(c=>c.toLowerCase().startsWith(typed)).map(c=>'<li role="option">'+c+'</li>').join('')}
country.onclick=()=>{open=!open;typed='';render();lb.hidden=!open;country.setAttribute('aria-expanded',open)}
addEventListener('keydown',e=>{if(open&&e.key.length===1){typed+=e.key.toLowerCase();render()}if(open&&e.key==='Enter'){const f=lb.querySelector('[role=option]');if(f)f.click();e.preventDefault()}})
lb.onclick=e=>{if(e.target.getAttribute('role')==='option'){country.textContent=e.target.textContent;open=false;lb.hidden=true;country.setAttribute('aria-expanded','false')}}
</script></body>`

let posts = 0
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  if (req.method === 'POST') { posts++; return res.end('<h1>Thank you for applying!</h1>') }
  res.end(FORM)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))

let calls = []
setModelBackend(async ({ kind, prompt }) => {
  const usage = { in: Math.ceil(prompt.length / 4), out: 60 }
  calls.push({ kind: kind || 'documents', in: usage.in })
  if (kind === 'parse_jd') return { text: '{"title":"Intern","company":"Test","must_have":["rust"],"keywords":[],"seniority":""}', usage }
  if (kind === 'reflect') return { text: '{"lessons":[]}', usage }
  let p
  try { p = JSON.parse(prompt.slice(0, prompt.indexOf('\n<untrusted_page>'))) } catch { p = null }
  if (!p) { calls[calls.length - 1].kind = 'documents'; return { text: /fact checker/.test(prompt) ? '{"results":[]}' : '{"experience_order":["e1"],"bullets":{},"projects":[],"skills":[]}', usage } }
  const els = p.elements || p.fields
  const by = re => els.find(e => re.test(e.label))
  if (kind === 'plan') {
    const rows = []
    const c = by(/^Country/); if (c && !c.value) rows.push({ ref: c.ref, action: 'choose', value: 'India', source: 'inferred', confidence: 'medium' })
    const py = by(/> Python/); if (py && !py.checked) rows.push({ ref: py.ref, action: 'check', source: 'inferred', confidence: 'medium' })
    const cv = by(/^Resume/); if (cv && !cv.value) rows.push({ ref: cv.ref, action: 'upload', doc: 'resume', source: 'document', confidence: 'high' })
    const q = by(new RegExp('^' + Q)); if (q && !q.value) rows.push({ ref: q.ref, action: 'fill', value: '', source: 'unknown', confidence: 'low' })
    return { text: JSON.stringify({ rows }), usage }
  }
  const q = by(new RegExp('^' + Q))
  if (q && !q.value) return { text: JSON.stringify({ action: 'ask_human', ref: q.ref, question: Q }), usage }
  const c = by(/^Country/); if (c && (!c.value || /select/i.test(c.value))) return { text: JSON.stringify({ action: 'choose', ref: c.ref, value: 'India', source: 'inferred', confidence: 'medium' }), usage }
  const py = by(/> Python/); if (py && !py.checked) return { text: JSON.stringify({ action: 'check', ref: py.ref, source: 'inferred', confidence: 'medium' }), usage }
  const cv = by(/^Resume/); if (cv && !cv.value) return { text: JSON.stringify({ action: 'upload', ref: cv.ref, doc: 'resume' }), usage }
  return { text: JSON.stringify({ action: 'click', ref: by(/^Submit application/).ref, reason: 'submit' }), usage }
})

process.env.ASK_WAIT_SECONDS = '4'; process.env.HEADLESS = '1'
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
const id = randomUUID()
await db.query("INSERT INTO profile (id, fields) VALUES (true, $1) ON CONFLICT (id) DO UPDATE SET fields=EXCLUDED.fields",
  [JSON.stringify({ first_name: 'Aarav', last_name: 'Mehta', email: 'a@example.com', location: 'Pune, India', experiences: [{ id: 'e1', company: 'Acme', title: 'Intern', bullets: ['Built a thing'] }] })])
await db.query("UPDATE settings SET value='false' WHERE key='kill_switch'")
await db.query("UPDATE jobs SET status='cancelled' WHERE status IN ('queued','running')")
await db.query("INSERT INTO jobs (id, application_url, mode) VALUES ($1, $2, 'review')", [id, `http://127.0.0.1:${server.address().port}/`])
const claim = await readFile(path.join(repo, 'db/claim_job.sql'), 'utf8')
const settings = { max_steps: 40, kill_switch: false, allowed_domains: [] }
const run = async () => {
  calls = []
  const job = (await db.query(claim, ['w-' + randomUUID(), '15 minutes'])).rows[0]
  const r = await runJob({ db, job, workerId: job.claimed_by, settings, policy: createPolicy({ allowLoopback: true }), resume: job.checkpoint })
  const kinds = calls.reduce((m, c) => ({ ...m, [c.kind]: (m[c.kind] || 0) + 1 }), {})
  return { status: r.status, calls: calls.length, tokens_in: calls.reduce((s, c) => s + c.in, 0), kinds }
}
const answer = async (kind, text) => {
  const q = (await db.query('SELECT id FROM questions WHERE job_id=$1 AND kind=$2 AND answer IS NULL ORDER BY id DESC LIMIT 1', [id, kind])).rows[0]
  await db.query('UPDATE questions SET answer=$2, answered_at=now() WHERE id=$1', [q.id, text])
  await db.query("UPDATE jobs SET status='queued' WHERE id=$1", [id])
}
const out = {}
try {
  out.run1 = await run()
  await answer('question', '3')
  out.run2_after_answer = await run()
  const pending = (await db.query("SELECT kind FROM questions WHERE job_id=$1 AND answer IS NULL", [id])).rows.map(r => r.kind)
  if (pending.includes('approval')) { await answer('approval', 'Approve'); out.run3_after_approve = await run() }
  else if (pending.length) { out.pending = pending }
  out.approvals_asked = (await db.query("SELECT count(*)::int n FROM questions WHERE job_id=$1 AND kind='approval'", [id])).rows[0].n
  out.resume_pdfs_made = (await db.query("SELECT count(*)::int n FROM documents WHERE job_id=$1 AND kind='resume'", [id])).rows[0].n
  out.posts = posts
  const filledSteps = (await db.query("SELECT kind AS action, count(*)::int n FROM job_steps WHERE job_id=$1 AND kind IN ('choose','check','upload','fill','prefill','plan_executed','ask_human','restore') GROUP BY kind ORDER BY kind", [id])).rows
  out.steps = Object.fromEntries(filledSteps.map(r => [r.action, r.n]))
  console.log(JSON.stringify(out, null, 1))
} finally {
  await db.end(); server.close()
}
