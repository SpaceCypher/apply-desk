// Daily scan of the job inbox for human replies about applied jobs. Stores them in inbox_messages.
import pg from 'pg'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { notify } from './lib/telegram.mjs'

const AUTOMATED = /no-?reply|do-?not-?reply|notifications?@|verify|confirm your|password|application (received|submitted)|thank you for applying/i

// Pure: decides which job (if any) an email belongs to.
export function matchJob(sender, subject, jobs) {
  const hay = `${sender} ${subject}`.toLowerCase()
  if (AUTOMATED.test(hay)) return null
  return jobs.find(j => {
    const company = (j.company || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
    const host = new URL(j.application_url).hostname.split('.').slice(-2, -1)[0]
    const compact = hay.replace(/[^a-z0-9]+/g, '')
    return (company.length > 2 && compact.includes(company)) || (host.length > 3 && !['greenhouse', 'lever', 'ashbyhq', 'myworkdayjobs', 'google'].includes(host) && compact.includes(host))
  }) || null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  const client = new ImapFlow({ host: process.env.IMAP_HOST || 'imap.gmail.com', port: 993, secure: true, logger: false, auth: { user: process.env.JOB_GMAIL_ADDRESS, pass: process.env.JOB_GMAIL_APP_PASSWORD } })
  try {
    const jobs = (await db.query("SELECT id, company, application_url FROM jobs WHERE status IN ('applied','submission_unverified')")).rows
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      const uids = await client.search({ since: new Date(Date.now() - 3 * 86400000) })
      for (const uid of uids) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: false })
        const mail = await simpleParser(msg.source)
        const sender = mail.from?.text || '', subject = mail.subject || ''
        const job = matchJob(sender, subject, jobs)
        if (!job) continue
        const exists = await db.query('SELECT 1 FROM inbox_messages WHERE job_id=$1 AND sender=$2 AND subject=$3', [job.id, sender, subject])
        if (exists.rowCount) continue
        await db.query('INSERT INTO inbox_messages (job_id, sender, subject) VALUES ($1,$2,$3)', [job.id, sender, subject])
        await notify(`Reply about ${job.company || job.application_url}\nFrom: ${sender}\n${subject}`)
      }
    } finally { lock.release() }
  } finally {
    await client.logout().catch(() => {})
    await db.end()
  }
}
