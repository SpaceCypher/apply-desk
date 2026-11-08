// Sensitive answers are only sent to the model when a form field asks for them.
const CATEGORIES = {
  gender: /\b(gender|sex|pronouns?)\b/i,
  race: /\b(race|ethnic\w*|hispanic|latino)\b/i,
  veteran: /\bveteran|military service\b/i,
  disability: /\bdisabilit\w*|handicap\b/i,
  birth_date: /\b(date of birth|birth ?date|dob|birthday)\b/i,
  citizenship: /\b(citizenship|nationality|visa status)\b/i,
  religion: /\breligio\w*\b/i,
  orientation: /\bsexual orientation|lgbt\w*\b/i,
}

export function sensitiveCategory(label) {
  return Object.keys(CATEGORIES).find(key => CATEGORIES[key].test(label)) || null
}

// profile.sensitive = { gender: { value: 'Male', mode: 'answer' | 'ask' } }
export function sensitiveDecision(label, profile) {
  const category = sensitiveCategory(label)
  if (!category) return null
  const entry = profile.sensitive?.[category]
  if (!entry?.value || entry.mode !== 'answer') return { category, action: 'ask' }
  return { category, action: 'answer', value: entry.value }
}

// The profile view the planner may see: no sensitive block, no long free text.
export function plannerProfile(profile) {
  const { sensitive, writing_samples, master_resume, resume_tex, ...rest } = profile
  return rest
}
