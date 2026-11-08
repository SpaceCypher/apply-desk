// Platform skills: deterministic, fast routines the planner can choose by name. Each declares when it applies
// (so the prompt can suggest it), its risk ('edit', 'account', or 'commit'), and returns a short description
// of what it did, or null when nothing applied.
import { workdayPass, present, id } from '../workday.mjs'

const fillIf = async (page, selector, value) => {
  if (!value) return false
  const loc = page.locator(selector).first()
  if (!await loc.isVisible().catch(() => false)) return false
  if ((await loc.inputValue().catch(() => '')) === value) return false
  await loc.fill(value, { timeout: 4000 }).catch(() => {})
  return (await loc.inputValue().catch(() => '')) === value
}
const uploadIf = async (env, selector) => {
  const loc = env.page.locator(selector).first()
  if (!await loc.count()) return false
  if ((await loc.evaluate(n => n.files?.length || 0).catch(() => 0)) > 0) return false
  await loc.setInputFiles(await env.upload('resume'), { timeout: 5000 })
  return true
}

// Workday: one routine per stage, all built on workdayPass (which acts on whichever stage the page is in,
// at most once per page). applies() keeps the model from calling one out of place.
const workday = [
  ['workday.choose_autofill', 'Pick "Autofill with Resume" in Workday\'s apply dialog.', 'edit', p => present(p, id('autofillWithResume'))],
  ['workday.apply_manually', 'Pick "Apply Manually" when there is no autofill option.', 'edit', async p => await present(p, id('applyManually')) && !await present(p, id('autofillWithResume'))],
  ['workday.open_apply', 'Click Workday\'s Apply button on the posting.', 'edit', async p => await present(p, id('adventureButton')) && !await present(p, id('applyManually'))],
  ['workday.account', 'Sign in with the saved login, or create the account (the password is saved first). Never in dry run.', 'account', async p => await present(p, id('password')) && await present(p, id('email'))],
  ['workday.fill_my_information', 'Fill My Information (name, city, phone, email, resume) from the profile.', 'edit', p => present(p, id('legalNameSection_firstName'))],
].map(([name, description, risk, applies]) => ({
  name, description, risk, applies,
  run: async env => {
    if (!await applies(env.page)) return null
    return workdayPass(env.page, env.ctx, env.profile, env.upload)
  },
}))

const greenhouse = [{
  name: 'greenhouse.fill_standard', risk: 'edit',
  description: 'Fill Greenhouse\'s standard fields (first/last name, email, phone, resume) from the profile.',
  applies: p => present(p, '#first_name'),
  run: async env => {
    const p = env.profile, page = env.page
    const did = [await fillIf(page, '#first_name', p.first_name), await fillIf(page, '#last_name', p.last_name), await fillIf(page, '#email', p.email),
      await fillIf(page, '#phone', p.phone), await uploadIf(env, 'input[type=file][id*=resume],input[type=file][name*=resume]')].filter(Boolean).length
    return did ? `filled ${did} standard fields` : null
  },
}]

const lever = [{
  name: 'lever.fill_standard', risk: 'edit',
  description: 'Fill Lever\'s standard fields (name, email, phone, LinkedIn, resume) from the profile.',
  applies: p => present(p, 'input[name=name]'),
  run: async env => {
    const p = env.profile, page = env.page
    const did = [await fillIf(page, 'input[name=name]', [p.first_name, p.last_name].filter(Boolean).join(' ')), await fillIf(page, 'input[name=email]', p.email),
      await fillIf(page, 'input[name=phone]', p.phone), await fillIf(page, 'input[name="urls[LinkedIn]"]', p.linkedin),
      await uploadIf(env, '#resume-upload-input,input[type=file][name=resume]')].filter(Boolean).length
    return did ? `filled ${did} standard fields` : null
  },
}]

const BY_PLATFORM = { workday, greenhouse, lever }
export const skillsFor = platform => BY_PLATFORM[platform] || []

// Skills that apply right now, for the prompt.
export async function applicableSkills(env) {
  const out = []
  for (const s of skillsFor(env.platform)) if (await s.applies(env.page).catch(() => false)) out.push({ name: s.name, description: s.description, risk: s.risk })
  return out
}
