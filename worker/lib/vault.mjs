import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto'

// AES-256-GCM. Format: iv.tag.ciphertext (base64url). Key: VAULT_KEY, 32 random bytes as base64.
function key(env = process.env) {
  const raw = Buffer.from(env.VAULT_KEY || '', 'base64')
  if (raw.length !== 32) throw new Error('VAULT_KEY must be 32 bytes, base64 encoded')
  return raw
}

export function encrypt(plain, env) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(env), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.')
}

export function decrypt(token, env) {
  const [iv, tag, data] = token.split('.').map(p => Buffer.from(p, 'base64url'))
  if (!iv || !tag || !data) throw new Error('Malformed vault value')
  const decipher = createDecipheriv('aes-256-gcm', key(env), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

// Meets common ATS rules: upper, lower, digit, symbol, 20 chars. { simple: true } is the fallback for a site that
// refuses it (length caps around 16, few allowed symbols): 14 chars with only ! @ #.
export function generatePassword({ simple = false } = {}) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', simple ? '!@#' : '!@#$%^&*-_']
  const all = sets.join('')
  const chars = sets.map(s => s[randomInt(s.length)])
  while (chars.length < (simple ? 14 : 20)) chars.push(all[randomInt(all.length)])
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

const MULTI_TENANT = ['myworkdayjobs.com', 'myworkdaysite.com', 'icims.com', 'taleo.net', 'oraclecloud.com', 'avature.net',
  'csod.com', 'successfactors.com', 'successfactors.eu', 'sapsf.com', 'sapsf.eu', 'darwinbox.in', 'darwinbox.com',
  'zohorecruit.com', 'zohorecruit.in', 'zohorecruit.eu', 'ultipro.com', 'paylocity.com', 'jobvite.com', 'brassring.com']

// Vault key is per registrable-ish domain. Workday is per employer (the tenant subdomain).
export function credentialDomain(hostname) {
  const host = hostname.toLowerCase()
  // Platforms where every employer has its own subdomain and its own candidate accounts: keep the full host, so
  // one employer's login is never tried on another's.
  if (MULTI_TENANT.some(d => host.endsWith('.' + d))) return host.replace(/^www\./, '')
  const parts = host.split('.')
  const twoPart = ['co.uk', 'co.in', 'com.au', 'co.jp']
  const tail = parts.slice(-2).join('.')
  return twoPart.includes(tail) ? parts.slice(-3).join('.') : tail
}
