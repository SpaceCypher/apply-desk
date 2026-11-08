import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

// Pulls a verification code or link out of an email body.
export function extractVerification(text, html = '') {
  const body = text || html.replace(/<\/?(?:p|div|br|td|tr|h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
  // Greenhouse prints an eight-character security code on its own line after explanatory prose.
  // Require verification context, rather than treating every eight-digit number as a code.
  const eight = [...body.matchAll(/(?:^|\n)[ \t]*([A-Za-z0-9]{8})[ \t]*(?=\r?$)/gm)].find(m => {
    const before = body.slice(Math.max(0, m.index - 500), m.index)
    const label = [...before.matchAll(/(?:security|verification|one[- ]time|8[- ]character)\s+code\b/gi)].at(-1)
    return label && !/\b(order|phone|telephone|invoice|reference|tracking|account number)\b/i.test(before.slice(label.index + label[0].length))
  })?.[1] || body.match(/(?:security|verification|one[- ]time|8[- ]character)\s+code\s*[:=]\s*([A-Za-z0-9]{8})\b/i)?.[1]
  const code = eight || body.match(/(?:code|otp|pin|verification)\s*(?:(?:is|:|=)\s*)?(\d{4,8})\b/i)?.[1] ||
    null
  const links = [...(html + ' ' + body).matchAll(/https:\/\/[^\s"'<>)]+/g)].map(m => m[0].replace(/[.,;]+$/, ''))
  const link = links.find(l => /verify|confirm|activate|validate|token|registration/i.test(l)) || null
  return { code, link }
}

// Words that identify a site's emails: the employer's name from the host and the platform's mail name. Workday
// tenants live on myworkdayjobs.com but mail from myworkday.com, so the bare second-level label never matched.
const GENERIC = new Set(['www', 'careers', 'career', 'jobs', 'job', 'apply', 'recruiting', 'recruitment', 'talent', 'hr', 'external', 'portal', 'en', 'us', 'com', 'net', 'org', 'io', 'co', 'in', 'uk', 'eu', 'ai', 'fa', 'ocs', 'hcm', 'boards', 'board', 'app', 'apps', 'login', 'secure', 'account', 'accounts', 'my'])
const PLATFORM_MAIL = { myworkdayjobs: 'workday', myworkdaysite: 'workday', oraclecloud: 'oracle', sapsf: 'successfactors', zohorecruit: 'zoho', smartrecruiters: 'smartrecruiters' }
export function senderTokens(host) {
  const labels = String(host).toLowerCase().split('.').flatMap(l => l.split('-'))
  return [...new Set(labels.filter(l => l.length >= 3 && !GENERIC.has(l) && !/^wd\d+$/.test(l) && !/^\d+$/.test(l)).map(l => PLATFORM_MAIL[l] || l))]
}
export const fromSite = (text, host) => senderTokens(host).some(t => text.toLowerCase().includes(t))

// Waits for a new message from `domainHint` after `since` and returns {code, link, subject, sender}.
export async function waitForVerification({ domainHint, since, timeoutMs = 180000, pollMs = 8000 }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await findRecent({ domainHint, since })
    if (found) return found
    await new Promise(r => setTimeout(r, pollMs))
  }
  return null
}

async function findRecent({ domainHint, since }) {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.gmail.com', port: 993, secure: true, logger: false,
    auth: { user: process.env.JOB_GMAIL_ADDRESS, pass: process.env.JOB_GMAIL_APP_PASSWORD },
  })
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const uids = await client.search({ since: new Date(since - 86400000) })
      for (const uid of [...uids].reverse().slice(0, 15)) {
        const message = await client.fetchOne(uid, { source: true, envelope: true, internalDate: true }, { uid: false })
        if (new Date(message.internalDate).getTime() < since - 60000) continue
        const parsed = await simpleParser(message.source)
        const sender = parsed.from?.text || ''
        if (domainHint && !fromSite(sender + ' ' + (parsed.subject || ''), domainHint)) continue
        const { code, link } = extractVerification(parsed.text || '', parsed.html || '')
        if (code || link) return { code, link, subject: parsed.subject || '', sender }
      }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
  return null
}
