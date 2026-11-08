const RULES = [
  ['workday', /(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$/],
  ['greenhouse', /(^|\.)greenhouse\.io$/],
  ['lever', /(^|\.)lever\.co$/],
  ['ashby', /(^|\.)ashbyhq\.com$/],
  ['google_forms', /^(docs\.google\.com|forms\.gle)$/],
  ['typeform', /(^|\.)typeform\.com$/],
  ['smartrecruiters', /(^|\.)smartrecruiters\.com$/],
]

export function detectPlatform(urlString, html = '') {
  const url = new URL(urlString)
  for (const [name, re] of RULES) {
    if (re.test(url.hostname)) {
      if (name === 'google_forms' && url.hostname === 'docs.google.com' && !url.pathname.startsWith('/forms')) continue
      return name
    }
  }
  // Companies embed ATS boards on their own domains.
  if (/boards\.greenhouse\.io|job-boards\.greenhouse\.io|grnhse_app/i.test(html)) return 'greenhouse'
  if (/jobs\.lever\.co/i.test(html)) return 'lever'
  if (/jobs\.ashbyhq\.com/i.test(html)) return 'ashby'
  return 'custom'
}
