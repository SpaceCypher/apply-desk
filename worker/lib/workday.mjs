import { credentialDomain } from './vault.mjs'
import { waitForVerification } from './mail.mjs'
import { getCredential, ensureCredential, verificationSince } from './account.mjs'

export const id = name => `[data-automation-id="${name}"]`
export async function present(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false)
}
// Phenom may expose the ATS destination in page data before its Apply control renders.
export function workdayApplyUrl(html) {
  const urls = new Set()
  for (const match of html.matchAll(/"applyUrl"\s*:\s*"([^"<>]+)"/g)) {
    let url
    try { url = new URL(JSON.parse(`"${match[1]}"`)) } catch { continue }
    if (url.protocol === 'https:' && !url.username && !url.password &&
        /^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/.test(url.hostname) && /\/apply\/?$/.test(url.pathname)) urls.add(url.href)
  }
  return urls.size === 1 ? [...urls][0] : null
}
// Workday renders its shell before loading the posting/account controls. Do not plan against an empty shell.
export async function waitForWorkday(page, timeout = 20000) {
  await page.locator([
    id('adventureButton'), id('autofillWithResume'), id('applyManually'), id('email'),
    id('legalNameSection_firstName'), id('bottom-navigation-next-button'),
    'input[type="file"]', '[role="alert"]',
  ].join(',')).filter({ visible: true }).first().waitFor({ state: 'visible', timeout }).catch(() => {})
}
async function pause(page) { await page.waitForTimeout(400 + Math.random() * 500) }
// Workday buttons sit under a click_filter overlay, and popovers (password rules, menus) can cover them.
// Close popovers, then really click the button or the click_filter carrying its label (Workday only listens
// to the click_filter). A synthetic event is the last resort: it always "succeeds" even when ignored.
async function press(page, name, label) {
  await page.keyboard.press('Escape').catch(() => {})
  const targets = [page.locator(id(name)).first(), page.locator(`${id('click_filter')}[aria-label="${label}"]`).first()]
  for (const loc of targets) if (await loc.click({ timeout: 4000 }).then(() => true, () => false)) return true
  return targets[1].dispatchEvent('click', {}, { timeout: 2000 }).then(() => true, () => false)
}

// Deterministic fast path for Workday's stable data-automation-id fields. Returns a label if it acted,
// so the agent loop re-observes. Each action runs at most once per page: when something does not stick
// (a reformatted phone, an unexpected dialog) the model planner sees the real page and decides instead.
export async function workdayPass(page, ctx, profile, upload) {
  const host = new URL(page.url()).hostname
  const domain = credentialDomain(host)
  const done = (ctx.workdayDone ??= new Set())
  const once = name => { const key = `${page.url().split('?')[0]}|${name}`; if (done.has(key)) return false; done.add(key); return true }
  const clickOnce = async name => {
    if (!await present(page, id(name)) || !once(name)) return false
    await page.locator(id(name)).first().click({ timeout: 5000 }); await pause(page)
    return true
  }

  // 1. Apply dialog first (the Apply button stays visible behind it), then the landing page's Apply.
  // Autofill with Resume lets Workday parse the tailored resume; the planner then checks what it filled.
  if (await clickOnce('autofillWithResume')) return 'chose autofill with resume'
  if (!await present(page, id('autofillWithResume')) && await clickOnce('applyManually')) return 'chose manual apply'
  if (await clickOnce('adventureButton')) return 'opened apply'

  // 2. Account: sign in with the vault, or create the account.
  const hasPassword = await present(page, id('password'))
  if (hasPassword && await present(page, id('email')) && once(await present(page, id('verifyPassword')) ? 'createAccount' : 'signIn')) {
    const existing = await getCredential(ctx.db, domain)
    const signUp = await present(page, id('verifyPassword'))
    if (ctx.job.mode === 'dry_run') throw Object.assign(new Error('Workday needs an account; dry runs never create one'), { dryRunBlock: true })
    // The site refused this password before (this run or an earlier one): never type it again. The planner resets
    // it through "Forgot password" ({{NEW_PASSWORD}}).
    if (existing && (existing.known_bad || ctx.loginRejected?.has(domain))) return null
    if (!signUp && existing) {
      ctx.secrets.PASSWORD = existing.password
      await page.locator(id('email')).first().fill(existing.username)
      await page.locator(id('password')).first().fill(existing.password)
      if (!await press(page, 'signInSubmitButton', 'Sign In')) await page.keyboard.press('Enter')
      await pause(page)
      return 'signed in'
    }
    if (!signUp) {
      // No stored login: switch to account creation.
      await press(page, 'createAccountLink', 'Create Account')
      await pause(page)
      return 'switched to create account'
    }
    // A retry often lands on Create Account although the account was made before: sign in instead.
    if (existing?.verified_at && await press(page, 'signInLink', 'Sign In')) { await pause(page); return 'switched to sign in' }
    // Stored before the sign-up form is sent (ensureCredential), so a run that fails right after still has it.
    const cred = await ensureCredential(ctx, domain)
    ctx.secrets.PASSWORD = cred.password
    const since = Date.now()
    await page.locator(id('email')).first().fill(cred.username)
    await page.locator(id('password')).first().fill(cred.password)
    await page.locator(id('verifyPassword')).first().fill(cred.password)
    if (await present(page, id('createAccountCheckbox'))) await page.locator(id('createAccountCheckbox')).first().check().catch(() => {})
    await ctx.audit('workday_create_account', { domain })
    await press(page, 'createAccountSubmitButton', 'Create Account')
    await pause(page)
    ctx.verifySince = since
    return 'created account'
  }

  // 3. Email verification, when the tenant asks for it. After a failed run the email may predate this run.
  if (/verify your email|check your email|verification (email|link)/i.test(await page.locator('body').innerText().catch(() => '')) && once('verifyEmail')) {
    const mail = await (ctx.mail?.waitForVerification || waitForVerification)({ domainHint: host, since: await verificationSince(ctx, page.url()) })
    ctx.verifySince = undefined
    if (mail?.link) { await ctx.gotoAllowed(mail.link); return 'verified email' }
    if (!mail) await ctx.ask({ kind: 'question', prompt: 'Workday wants an email verification I could not find in the job inbox. Verify it manually, then reply done.', remember: false })
    return 'verification handled'
  }

  // 4. My Information: standard fields.
  let acted = false
  const fill = async (automationId, value) => {
    if (!value) return
    const loc = page.locator(id(automationId)).first()
    if (!await loc.isVisible().catch(() => false) || !once(automationId)) return
    if ((await loc.inputValue().catch(() => '')) === value) return
    await loc.fill(value, { timeout: 4000 }).catch(() => {})
    acted = true
  }
  await fill('legalNameSection_firstName', profile.first_name)
  await fill('legalNameSection_lastName', profile.last_name)
  await fill('addressSection_city', (profile.location || '').split(',')[0].trim())
  await fill('phone-number', (profile.phone || '').replace(/^\+\d{1,3}\s*/, ''))
  await fill('email', profile.email)
  if (await present(page, 'input[type=file]') && !ctx.workdayResume) {
    const file = await upload('resume')
    if (file) { await page.locator('input[type=file]').first().setInputFiles(file); ctx.workdayResume = true; acted = true }
  }
  if (acted) { await pause(page); return 'filled standard fields' }
  return null
}
