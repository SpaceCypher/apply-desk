// Accounts on employer sites. The vault keeps one login per site (credentialDomain). Its lifecycle:
//   created (saved before the sign-up form is sent) -> verified (the site accepted the password)
//   -> rejected (the site said the password is wrong: never typed again, reset through "Forgot password")
//   -> pending new password ({{NEW_PASSWORD}}) -> becomes the saved password once the site accepts it.
// After every action that sends an account form, afterAccountAction() reads the result and moves the lifecycle on.
import { accountPage, observe } from './perception/walk.mjs'
import { credentialDomain, generatePassword, encrypt, decrypt } from './vault.mjs'
import { Stop } from './context.mjs'

export const REJECTED = /(incorrect|invalid|wrong|doesn'?t match|does not match|not recogni[sz]ed|unable to (sign|log) ?in|couldn'?t (sign|log) you in|authentication failed)[^.\n]{0,40}(password|credentials|e-?mail|user ?name|login|sign[- ]?in)|(password|credentials|e-?mail or password|user ?name or password)[^.\n]{0,40}(incorrect|invalid|wrong|not (valid|correct|recogni[sz]ed)|did not match|does not match)/i
export const EXISTS = /(account|user|e-?mail( address)?)[^.\n]{0,40}(already (exists|registered|in use|taken|been used)|is already (registered|associated|in use))|already have an account with this/i
export const PASSWORD_RULE = /password[^.\n]{0,80}(must|at least|should (contain|have|include|be)|requires?\b|cannot|can'?t|not (allowed|permitted|valid)|too (short|long|weak)|invalid character|special character|maximum|minimum)/i
export const LOCKED = /account (is |has been )?(temporarily )?(locked|disabled|suspended)|too many (failed |unsuccessful |invalid )?(sign[- ]?in |login |log-in )?attempts/i
// An account form's own send button. Links ("Forgot password", "Create account") switch pages and say nothing about
// the password.
const SENDS_FORM = /^(sign ?in|log ?in|sign ?up|create( an)? account|register|submit|continue|next|confirm|verify|save|reset( password)?|change password|set password|update password|join|get started)\b/i

export const domainOf = url => { try { return credentialDomain(new URL(url).hostname) } catch { return '' } }

export async function getCredential(db, domain) {
  const row = (await db.query('SELECT username_enc, password_enc, password_pending_enc, verified_at, rejected_at, created_at FROM credentials WHERE domain=$1', [domain])
    .catch(() => db.query('SELECT username_enc, password_enc, created_at FROM credentials WHERE domain=$1', [domain]))).rows[0]
  if (!row) return null
  return {
    username: decrypt(row.username_enc), password: decrypt(row.password_enc), pending: row.password_pending_enc ? decrypt(row.password_pending_enc) : null,
    verified_at: row.verified_at || null, rejected_at: row.rejected_at || null, created_at: row.created_at,
    // Refused by the site and not accepted since: typing it again only risks locking the account.
    known_bad: !!row.rejected_at && (!row.verified_at || new Date(row.rejected_at) > new Date(row.verified_at)),
  }
}

// The saved login for this site, or a new one stored BEFORE any sign-up form is sent. Two runs racing on the same
// site both end up with the stored row (ON CONFLICT DO NOTHING, then read back).
export async function ensureCredential(ctx, domain) {
  const existing = await getCredential(ctx.db, domain)
  if (existing) return existing
  if (ctx.job.mode === 'dry_run') throw new Stop('needs_user', 'This site needs an account. Dry runs never create one.')
  const username = process.env.JOB_GMAIL_ADDRESS
  if (!username) throw new Stop('needs_user', 'This site needs an account, and JOB_GMAIL_ADDRESS (the job inbox) is not set for the worker.')
  await ctx.db.query('INSERT INTO credentials (domain, username_enc, password_enc) VALUES ($1,$2,$3) ON CONFLICT (domain) DO NOTHING',
    [domain, encrypt(username), encrypt(generatePassword())])
  await ctx.audit('credential_created', { domain })
  ctx.verifySince ??= Date.now()
  return getCredential(ctx.db, domain)
}

// Secrets for the account placeholders on this site. {{PASSWORD}} is refused once the site has rejected it (in this
// run or an earlier one) until a reset succeeds; {{NEW_PASSWORD}} starts that reset.
export async function accountSecret(ctx, domain, key) {
  const cred = await ensureCredential(ctx, domain)
  ctx.secrets.EMAIL ??= cred.username
  if (key === 'EMAIL') return cred.username
  ctx.loginRejected ??= new Set()
  if (key === 'PASSWORD') {
    if (ctx.loginRejected.has(domain) || cred.known_bad) {
      ctx.loginRejected.add(domain)
      throw new Error('login_rejected: this site refused the saved password. Do not type it again: use "Forgot password", read_email, open_email_link, then {{NEW_PASSWORD}} in the new password fields')
    }
    return cred.password
  }
  if (key === 'NEW_PASSWORD') {
    if (ctx.job.mode === 'dry_run') throw new Stop('needs_user', 'Resetting a password is not done in a dry run.')
    if (cred.pending) return cred.pending
    const fresh = generatePassword({ simple: !!ctx.simplePassword })
    await ctx.db.query('UPDATE credentials SET password_pending_enc=$2, updated_at=now() WHERE domain=$1', [domain, encrypt(fresh)])
    await ctx.audit('credential_reset_started', { domain })
    return fresh
  }
  return null
}

// Clears secrets cached for this run so the next placeholder reads the vault again.
const forget = (ctx, ...keys) => { for (const k of keys) delete ctx.secrets[k] }

async function verified(ctx, domain) {
  await ctx.db.query('UPDATE credentials SET verified_at=now(), rejected_at=NULL, updated_at=now() WHERE domain=$1', [domain]).catch(() => {})
}

async function promotePending(ctx, domain) {
  const cred = await getCredential(ctx.db, domain)
  if (!cred?.pending) return false
  await ctx.db.query('UPDATE credentials SET password_enc=password_pending_enc, password_pending_enc=NULL, verified_at=now(), rejected_at=NULL, updated_at=now() WHERE domain=$1', [domain])
  ctx.loginRejected?.delete(domain)
  forget(ctx, 'PASSWORD', 'NEW_PASSWORD')
  await ctx.audit('credential_reset_done', { domain })
  await ctx.notify(`The saved password for ${domain} was refused, so I reset it through the job inbox. The new one is in the vault.`)
  return true
}

/**
 * Called by dispatch() after an action on an account page (kindBefore from accountPage). Returns a replacement
 * result for the planner ('error:<why>: <what to do>') or null to keep the action's own result.
 */
export async function afterAccountAction(env, kindBefore, a, el) {
  const { ctx, page } = env
  const pressed = a.action === 'press_key' ? a.key === 'Enter' : a.action === 'skill' || (el ? el.tag !== 'a' && SENDS_FORM.test((el.label || '').trim()) : a.action === 'click_at')
  if (!pressed) return null
  const domain = domainOf(env.obs.url)
  if (!domain) return null
  await page.waitForTimeout(600)
  const after = await observe(page).catch(() => null)
  if (!after) return null
  const said = `${after.alerts.join('\n')}\n${after.elements.filter(e => e.error).map(e => e.error).join('\n')}\n${after.text.slice(0, 3000)}`
  const kindAfter = accountPage(after.elements)
  const stillThere = kindAfter === kindBefore
  ctx.loginRejected ??= new Set()

  if (LOCKED.test(said)) {
    await ctx.notify(`The site locked the account on ${domain}. Unlock it from the job inbox or the site, then retry the job.`)
    throw new Stop('needs_user', `The site locked the account on ${domain}.`)
  }
  if (kindBefore === 'sign_in') {
    if (stillThere && REJECTED.test(said)) {
      ctx.loginRejected.add(domain)
      await ctx.db.query('UPDATE credentials SET rejected_at=now(), updated_at=now() WHERE domain=$1', [domain]).catch(() => {})
      await ctx.flag(`The saved password for ${domain} was refused`)
      forget(ctx, 'PASSWORD')
      return 'error:login_rejected: the saved password was refused. Do not type it again. Click "Forgot password", request the email, read_email, open_email_link, and put {{NEW_PASSWORD}} in the new password fields'
    }
    if (!kindAfter && !after.elements.some(e => e.type === 'password')) await verified(ctx, domain)
    return null
  }
  if (kindBefore === 'sign_up') {
    if (EXISTS.test(said)) return 'error:account_exists: this email already has an account here. Switch to the sign-in page and sign in with {{EMAIL}} and {{PASSWORD}}'
    if (stillThere && PASSWORD_RULE.test(said)) {
      const cred = await getCredential(ctx.db, domain)
      if (cred && !cred.verified_at && !ctx.simplePassword) {
        // The site never accepted this password, so nothing depends on it: store a simpler one and try once more.
        ctx.simplePassword = true
        await ctx.db.query('UPDATE credentials SET password_enc=$2, updated_at=now() WHERE domain=$1', [domain, encrypt(generatePassword({ simple: true }))])
        forget(ctx, 'PASSWORD')
        await ctx.audit('credential_password_simplified', { domain })
        return 'error:password_rule: the site refused the password format; a simpler one was saved. Fill every password field again with {{PASSWORD}} and send the form once more'
      }
      return null
    }
    if (!kindAfter && !after.elements.some(e => e.type === 'password')) await verified(ctx, domain)
    return null
  }
  if (kindBefore === 'reset') {
    if (stillThere && PASSWORD_RULE.test(said) && !ctx.simplePassword) {
      ctx.simplePassword = true
      await ctx.db.query('UPDATE credentials SET password_pending_enc=$2, updated_at=now() WHERE domain=$1', [domain, encrypt(generatePassword({ simple: true }))])
      forget(ctx, 'NEW_PASSWORD')
      return 'error:password_rule: the site refused the new password format; a simpler one was made. Fill the new password fields again with {{NEW_PASSWORD}} and send once more'
    }
    if (!stillThere && !EXISTS.test(said) && !REJECTED.test(said)) await promotePending(ctx, domain)
    return null
  }
  return null
}

// Earliest time a verification email for this site could have been sent: the credential's creation while the site
// has not accepted it yet (a retry after a failed run), else the last 10 minutes.
export async function verificationSince(ctx, url) {
  if (ctx.verifySince) return ctx.verifySince
  const cred = await getCredential(ctx.db, domainOf(url)).catch(() => null)
  if (cred && !cred.verified_at && cred.created_at) return new Date(cred.created_at).getTime() - 60000
  return Date.now() - 600000
}
