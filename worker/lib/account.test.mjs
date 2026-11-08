// Accounts on a fake employer site (sign-up, sign-in, forgot and reset pages, an outbox instead of IMAP): what a
// retry does when the account already exists, when the saved password is refused, and when sign-up refuses the
// password format. Account buttons must never take the application submit lock.
// Needs DATABASE_URL (migrated) and a Chromium (CHROMIUM_PATH). Skipped otherwise.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import { chromium } from 'playwright'
import { createContext } from './context.mjs'
import { observe } from './perception/walk.mjs'
import { dispatch, makeSubmit, followTracking } from './actions/registry.mjs'
import { encrypt, decrypt, credentialDomain } from './vault.mjs'
import { senderTokens, fromSite } from './mail.mjs'
import { PASSWORD_RULE } from './account.mjs'

const skip = !process.env.DATABASE_URL || !process.env.CHROMIUM_PATH
process.env.VAULT_KEY ||= randomBytes(32).toString('base64')
process.env.JOB_GMAIL_ADDRESS ||= 'jobs.test@example.com'
const EMAIL = process.env.JOB_GMAIL_ADDRESS

function fakeSite({ password = null, maxLen = 64 } = {}) {
  const site = { password, maxLen, signInAttempts: 0, outbox: [], posts: [] }
  const page = (title, body, note = '') => `<!doctype html><title>${title}</title><body><h1>${title}</h1>${note ? `<p role="alert">${note}</p>` : ''}${body}</body>`
  const form = (action, fields, button, extra = '') => `<form method="post" action="${action}">${fields.map(([l, n, t]) => `<label for="${n}">${l}</label><input id="${n}" name="${n}" type="${t}">`).join('')}<button type="submit">${button}</button></form>${extra}`
  site.server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    let body = ''; for await (const c of req) body += c
    const f = Object.fromEntries(new URLSearchParams(body))
    const signedIn = /session=1/.test(req.headers.cookie || '')
    const go = to => { res.writeHead(303, { location: to }); res.end() }
    res.setHeader('content-type', 'text/html')
    if (req.method === 'POST') site.posts.push(url.pathname)
    if (url.pathname === '/signin' && req.method === 'POST') {
      site.signInAttempts++
      if (site.password && f.email === EMAIL && f.password === site.password) { res.setHeader('set-cookie', 'session=1; Path=/'); return go('/apply') }
      return go('/signin?err=1')
    }
    if (url.pathname === '/signup' && req.method === 'POST') {
      if (site.password) return go('/signup?err=exists')
      if ((f.password || '').length > site.maxLen) return go('/signup?err=rule')
      site.password = f.password; res.setHeader('set-cookie', 'session=1; Path=/'); return go('/apply')
    }
    if (url.pathname === '/forgot' && req.method === 'POST') {
      site.outbox.push({ link: `http://127.0.0.1:${site.server.address().port}/reset?token=t1`, subject: 'Reset your Acme password', sender: 'Acme Careers <no-reply@acme.example>' })
      return res.end(page('Check your email', '<p>We sent you a link to reset your password.</p>'))
    }
    if (url.pathname === '/reset' && req.method === 'POST') {
      if ((f.password || '').length > site.maxLen) return go('/reset?token=t1&err=rule')
      site.password = f.password; return go('/signin?reset=1')
    }
    if (url.pathname === '/signin') return res.end(page('Sign in', form('/signin', [['Email address', 'email', 'email'], ['Password', 'password', 'password']], 'Sign in',
      '<a href="/forgot">Forgot password?</a> <a href="/signup">Create account</a>'), url.searchParams.get('err') ? 'Incorrect email or password.' : url.searchParams.get('reset') ? 'Your password was changed. Sign in.' : ''))
    if (url.pathname === '/signup') return res.end(page('Create account', form('/signup', [['Email address', 'email', 'email'], ['Password', 'password', 'password'], ['Verify password', 'verify', 'password']], 'Submit',
      '<a href="/signin">Sign in</a>'), { exists: 'An account with this email address already exists.', rule: `Password must be at most ${site.maxLen} characters.` }[url.searchParams.get('err')] || ''))
    if (url.pathname === '/forgot') return res.end(page('Forgot password', form('/forgot', [['Email address', 'email', 'email']], 'Send reset link')))
    if (url.pathname === '/reset') return res.end(page('Choose a new password', form('/reset', [['New password', 'password', 'password'], ['Confirm new password', 'confirm', 'password']], 'Submit'),
      url.searchParams.get('err') ? `Password must be at most ${site.maxLen} characters.` : ''))
    if (url.pathname === '/apply') return signedIn ? res.end(page('Apply', form('/submit', [['First name', 'fn', 'text'], ['Phone', 'ph', 'tel']], 'Submit application'))) : go('/signin')
    res.end(page('Thank you for applying!', ''))
  })
  return site
}

async function harness(t, siteOpts, start) {
  const site = fakeSite(siteOpts)
  await new Promise(r => site.server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${site.server.address().port}`
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
  const domain = credentialDomain('127.0.0.1')
  await db.query('DELETE FROM credentials WHERE domain=$1', [domain])
  const id = randomUUID()
  await db.query("INSERT INTO jobs (id, application_url, mode, status, claimed_by, lease_until) VALUES ($1,$2,'review','running','w',now()+interval '1 hour')", [id, `${base}/apply`])
  const job = (await db.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0]
  const ctx = createContext({ db, job, workerId: 'w', settings: {} })
  ctx.allowedDomains = []
  ctx.notes = []; ctx.notify = async m => { ctx.notes.push(m) }
  ctx.heartbeat = async () => {}
  ctx.asked = []; ctx.ask = async q => { ctx.asked.push(q.kind); return q.kind === 'approval' ? 'Reject' : 'skip' }
  ctx.mail = { waitForVerification: async () => site.outbox.at(-1) || null }
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  const page = await browser.newPage()
  ctx.gotoAllowed = async to => { await page.goto(to) }
  await page.goto(base + start)
  const env = { page, ctx, profile: { first_name: 'Aarav' }, bank: [], upload: async () => '/dev/null', mode: 'review', filled: [], platform: 'custom', shot: null }
  env.submit = makeSubmit(env)
  const act = async (action, label, extra = {}) => {
    env.obs = await observe(page)
    const ref = label == null ? undefined : env.obs.elements.find(e => e.label === label)?.ref
    if (label != null) assert.ok(ref, `no "${label}" on ${page.url()}`)
    const r = await dispatch(env, { action, ref, source: 'profile', confidence: 'high', ...extra })
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    return r.result
  }
  const cred = async () => {
    const row = (await db.query('SELECT * FROM credentials WHERE domain=$1', [domain])).rows[0]
    return row && { ...row, password: decrypt(row.password_enc), pending: row.password_pending_enc && decrypt(row.password_pending_enc) }
  }
  t.after(async () => { await browser.close(); await db.end(); await new Promise(r => site.server.close(r)) })
  return { site, db, domain, env, page, ctx, act, cred, id, base }
}

const noApplicationSubmit = async ({ db, id, ctx, site }) => {
  assert.ok(!ctx.asked.includes('approval'), 'no approval was asked for an account form')
  assert.equal((await db.query('SELECT submit_attempted_at FROM jobs WHERE id=$1', [id])).rows[0].submit_attempted_at, null)
  assert.ok(!site.posts.includes('/submit'))
}

test('retry lands on sign-up for an existing account: told to sign in, signs in, login marked verified', { skip, timeout: 60000 }, async t => {
  const h = await harness(t, { password: 'Saved-Pass-123' }, '/signup')
  await h.db.query('INSERT INTO credentials (domain, username_enc, password_enc) VALUES ($1,$2,$3)', [h.domain, encrypt(EMAIL), encrypt('Saved-Pass-123')])
  await h.act('fill', 'Email address', { value: '{{EMAIL}}' })
  await h.act('fill', 'Password', { value: '{{PASSWORD}}' })
  await h.act('fill', 'Verify password', { value: '{{PASSWORD}}' })
  assert.match(await h.act('click', 'Submit'), /^error:account_exists/)
  await h.act('click', 'Sign in')
  await h.act('fill', 'Email address', { value: '{{EMAIL}}' })
  await h.act('fill', 'Password', { value: '{{PASSWORD}}' })
  await h.act('click', 'Sign in')
  assert.match(h.page.url(), /\/apply$/)
  assert.ok((await h.cred()).verified_at, 'the site accepted it: verified')
  await noApplicationSubmit(h)
})

test('a refused saved password is never typed again; reset through the inbox; new password saved and used', { skip, timeout: 60000 }, async t => {
  const h = await harness(t, { password: 'Real-Pass-456' }, '/signin')
  await h.db.query('INSERT INTO credentials (domain, username_enc, password_enc) VALUES ($1,$2,$3)', [h.domain, encrypt(EMAIL), encrypt('Never-Accepted-1')])
  await h.act('fill', 'Email address', { value: '{{EMAIL}}' })
  await h.act('fill', 'Password', { value: '{{PASSWORD}}' })
  assert.match(await h.act('click', 'Sign in'), /^error:login_rejected/)
  assert.ok((await h.cred()).rejected_at)
  // The lockout guard: the same password is refused before it reaches the site.
  assert.match(await h.act('fill', 'Password', { value: '{{PASSWORD}}' }), /login_rejected/)
  assert.equal(h.site.signInAttempts, 1)

  await h.act('click', 'Forgot password?')
  await h.act('fill', 'Email address', { value: '{{EMAIL}}' })
  await h.act('click', 'Send reset link')
  assert.match(await h.act('read_email'), /^ok/)
  assert.match(await h.act('open_email_link'), /^ok/)
  await h.act('fill', 'New password', { value: '{{NEW_PASSWORD}}' })
  await h.act('fill', 'Confirm new password', { value: '{{NEW_PASSWORD}}' })
  const pending = (await h.cred()).pending
  assert.ok(pending, 'the new password is stored before the reset is sent')
  await h.act('click', 'Submit')
  const after = await h.cred()
  assert.equal(after.password, h.site.password, 'the vault holds the password the site now has')
  assert.equal(after.password, pending); assert.equal(after.pending, null)
  assert.ok(h.ctx.notes.some(n => /reset it through the job inbox/.test(n)))

  await h.act('fill', 'Email address', { value: '{{EMAIL}}' })
  await h.act('fill', 'Password', { value: '{{PASSWORD}}' })
  await h.act('click', 'Sign in')
  assert.match(h.page.url(), /\/apply$/)
  assert.ok((await h.cred()).verified_at)
  await noApplicationSubmit(h)

  // A later run (fresh context) knows the old password was bad only until the reset: it signs in normally.
  const fresh = await harness(t, { password: after.password }, '/signin')
  await fresh.db.query('INSERT INTO credentials (domain, username_enc, password_enc, verified_at) VALUES ($1,$2,$3,now())', [fresh.domain, encrypt(EMAIL), encrypt(after.password)])
  await fresh.act('fill', 'Email address', { value: '{{EMAIL}}' })
  assert.match(await fresh.act('fill', 'Password', { value: '{{PASSWORD}}' }), /^ok/)
})

test('a retry after a refused login does not type the refused password, even in a new run', { skip, timeout: 60000 }, async t => {
  const h = await harness(t, { password: 'Real-Pass-456' }, '/signin')
  await h.db.query("INSERT INTO credentials (domain, username_enc, password_enc, rejected_at) VALUES ($1,$2,$3,now())", [h.domain, encrypt(EMAIL), encrypt('Never-Accepted-1')])
  assert.match(await h.act('fill', 'Password', { value: '{{PASSWORD}}' }), /login_rejected/)
  assert.equal(h.site.signInAttempts, 0)
})

test('sign-up refuses the password format: a simpler password is saved and sign-up succeeds', { skip, timeout: 60000 }, async t => {
  const h = await harness(t, { maxLen: 16 }, '/signup')
  await h.act('fill', 'Email address', { value: '{{EMAIL}}' })
  const first = (await h.cred()).password
  assert.equal(first.length, 20, 'the login is stored before the sign-up form is sent')
  await h.act('fill', 'Password', { value: '{{PASSWORD}}' })
  await h.act('fill', 'Verify password', { value: '{{PASSWORD}}' })
  assert.match(await h.act('click', 'Submit'), /^error:password_rule/)
  const second = (await h.cred()).password
  assert.equal(second.length, 14)
  await h.act('fill', 'Password', { value: '{{PASSWORD}}' })
  await h.act('fill', 'Verify password', { value: '{{PASSWORD}}' })
  await h.act('click', 'Submit')
  assert.match(h.page.url(), /\/apply$/)
  assert.equal(h.site.password, second)
  assert.ok((await h.cred()).verified_at)
  await noApplicationSubmit(h)
})

test('verification emails match the employer or platform; tracking links are followed to an allowed host', async () => {
  assert.deepEqual(senderTokens('acme.wd5.myworkdayjobs.com'), ['acme', 'workday'])
  assert.ok(fromSite('Acme <acme@myworkday.com> Verify your account', 'acme.wd5.myworkdayjobs.com'))
  assert.ok(!fromSite('Newsletter <news@shop.example>', 'acme.wd5.myworkdayjobs.com'))
  const ctx = { job: { application_url: 'https://acme.wd5.myworkdayjobs.com/job/1' }, allowedDomains: [], checkHost: async () => {} }
  const hops = { 'https://click.mailer.example/t/1': 'https://click.mailer.example/t/2', 'https://click.mailer.example/t/2': 'https://acme.wd5.myworkdayjobs.com/verify?t=9' }
  const fakeFetch = async url => ({ status: hops[url] ? 302 : 200, headers: new Map([['location', hops[url]]]) })
  assert.equal(await followTracking(ctx, 'https://click.mailer.example/t/1', fakeFetch), 'https://acme.wd5.myworkdayjobs.com/verify?t=9')
  await assert.rejects(followTracking(ctx, 'https://evil.example/x', async () => ({ status: 200, headers: new Map() })), /not on the allowlist/)
  const blocked = { ...ctx, checkHost: async () => { throw new Error('private address') } }
  await assert.rejects(followTracking(blocked, 'https://click.mailer.example/t/1', fakeFetch), /private address/)
})

test('employers on shared platforms get their own saved login', async () => {
  assert.equal(credentialDomain('careers-acme.icims.com'), 'careers-acme.icims.com')
  assert.equal(credentialDomain('acme.taleo.net'), 'acme.taleo.net')
  assert.equal(credentialDomain('acme.wd5.myworkdayjobs.com'), 'acme.wd5.myworkdayjobs.com')
  assert.equal(credentialDomain('jobs.smartrecruiters.com'), 'smartrecruiters.com', 'one SmartRecruiters account serves every employer')
})


test('Workday password requirements heading is help, not a password rejection', () => {
  const help = 'Password Requirements:\nA lowercase character\nAn uppercase character\nA special character\nA numeric character\nA minimum of 8 characters\nAn alphabetic character'
  assert.equal(PASSWORD_RULE.test(help), false)
  assert.equal(PASSWORD_RULE.test('Password requires a special character.'), true)
  assert.equal(PASSWORD_RULE.test('Password must be at most 16 characters.'), true)
})
