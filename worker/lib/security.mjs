import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

export const KNOWN_ATS_SUFFIXES = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'myworkdaysite.com', 'workday.com',
  'smartrecruiters.com', 'icims.com', 'docs.google.com', 'forms.gle', 'typeform.com', 'workable.com',
  'avature.net', 'successfactors.com', 'successfactors.eu', 'oraclecloud.com',
  'recruitee.com', 'breezy.hr', 'bamboohr.com', 'jobvite.com', 'hcaptcha.com', 'recaptcha.net',
  'google.com', 'gstatic.com', 'cloudflare.com', 'challenges.cloudflare.com',
]

export function hostMatches(hostname, suffix) {
  const h = hostname.toLowerCase()
  const s = suffix.toLowerCase().replace(/^\*?\./, '')
  return h === s || h.endsWith('.' + s)
}

// A request may only reach the job's own site (and its parent domain), known ATS domains,
// and domains the user added in Settings.
// File attachments that a job board stores outside its own domain before Submit (Greenhouse posts the resume to its
// S3 bucket the moment it is attached). Writes only; navigation to these hosts stays blocked.
// ponytail: Greenhouse only (seen on a real form); add Lever/Ashby/Workday buckets when a real upload shows them.
const ATS_UPLOAD_HOST = /^grnhse-[a-z0-9-]+\.s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/
export const isAtsUploadHost = hostname => ATS_UPLOAD_HOST.test(hostname)

export function isAllowedHost(hostname, jobUrl, extra = []) {
  const jobHost = new URL(jobUrl).hostname
  const jobBase = jobHost.split('.').slice(-2).join('.')
  return hostMatches(hostname, jobHost) || hostMatches(hostname, jobBase) ||
    [...KNOWN_ATS_SUFFIXES, ...extra].some(s => hostMatches(hostname, s))
}

export function assertPublicUrlShape(url) {
  if (url.protocol !== 'https:' || url.username || url.password || isIP(url.hostname) ||
      url.hostname === 'localhost' || url.hostname.endsWith('.local')) {
    throw new Error('A public HTTPS URL is required')
  }
}

const publicCache = new Map()
// Resolves a hostname and rejects anything that is not a public unicast address.
export async function assertPublicHost(hostname, resolver = lookup) {
  if (publicCache.get(hostname)) return
  const addresses = await resolver(hostname, { all: true })
  if (!addresses.length || addresses.some(({ address }) => ipaddr.parse(address).range() !== 'unicast')) {
    throw new Error(`Blocked non-public host ${hostname}`)
  }
  publicCache.set(hostname, true)
}

// Hard stop: forms that ask for money or identity numbers are scams or out of scope.
const FORBIDDEN = [
  /\b(credit|debit)\s*card\b/i, /\bcard\s*number\b/i, /\bcvv\b|\bcvc\b/i, /\bbank\s*account\b/i,
  /\brouting\s*number\b/i, /\biban\b/i, /\bsocial\s*security\b|\bssn\b/i, /\baadhaar\b|\bpan\s*number\b/i,
  /\b(application|registration|processing|training)\s*fee\b/i, /\bpay(ment)?\s*(a\s*)?fee\b/i,
  /\bwire\s*transfer\b/i, /\bgift\s*cards?\b/i,
]
export function forbiddenRequest(text) {
  const hit = FORBIDDEN.find(re => re.test(text))
  return hit ? hit.source : null
}

const SCAM = [
  [/registration fee|security deposit|training fee|pay for (your )?(equipment|laptop)/i, 'asks for an upfront payment'],
  [/whatsapp|telegram.{0,20}(interview|contact)/i, 'moves the conversation to chat apps'],
  [/(earn|make)\s+\$?\d[\d,]*\s*(\/|per)\s*(day|hour|week).{0,40}(no experience|from home)/i, 'unrealistic pay for no experience'],
  [/check\s*(deposit|cashing)|send.{0,20}(crypto|bitcoin)/i, 'mentions cheque deposits or crypto'],
  [/no\s+interview\s+(needed|required)|hired\s+immediately/i, 'promises hiring without an interview'],
]
export function scamFlags(text) {
  return SCAM.filter(([re]) => re.test(text)).map(([, why]) => why)
}

const CLOSED = /no longer (accepting|available)|position (has been|is) (filled|closed)|job (is )?(closed|expired|no longer)|this (job|posting|role) (has )?(expired|been removed)|page (you are looking for )?(not found|doesn't exist)/i
export function looksClosed(text, status) {
  return status === 404 || status === 410 || CLOSED.test(text.slice(0, 5000))
}

const BOT = /\b403\s+forbidden\b|access denied|you have been blocked|unusual traffic|verify you are human|attention required.{0,20}cloudflare|request blocked|pardon our interruption/i
export function looksBotBlocked(text, title = '') {
  return BOT.test(title + '\n' + text.slice(0, 2000))
}

// Page text is data. Wrap it so the planner prompt can state that nothing inside is an instruction.
export function untrusted(text, limit = 6000) {
  const clean = text.replace(/<\/?untrusted_page>/gi, '').replace(/\s+\n/g, '\n').slice(0, limit)
  return `<untrusted_page>\n${clean}\n</untrusted_page>`
}

// Common injection phrases are flagged, never obeyed. Used to warn the user.
const INJECTION = /ignore (all |any )?(previous|prior|above) (instructions|prompts)|disregard (the )?(system|previous)|you are now|new instructions:|reveal (your )?(system prompt|password|credentials)|send .{0,40}(password|secret|api key)/i
export function injectionSuspected(text) {
  return INJECTION.test(text)
}

// Strips secrets from anything that gets logged.
export function redact(value, secrets) {
  let out = typeof value === 'string' ? value : JSON.stringify(value)
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]')
  return out
}

// URL policy for one run. Production: public HTTPS only. The bench entry point (and nothing else) builds a
// policy with allowLoopback so it can serve local fixture pages; run.mjs never does.
export function createPolicy({ allowLoopback = false } = {}) {
  const loopback = host => ['127.0.0.1', 'localhost', '::1'].includes(host)
  return {
    allowLoopback,
    checkJobUrl(url) {
      if (allowLoopback && loopback(url.hostname) && ['http:', 'https:'].includes(url.protocol)) return
      assertPublicUrlShape(url)
    },
    async checkHost(url) {
      if (allowLoopback && loopback(url.hostname)) return
      if (url.protocol !== 'https:') throw new Error('plain http')
      await assertPublicHost(url.hostname)
    },
  }
}
