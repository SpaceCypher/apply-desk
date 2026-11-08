// The network guard for an engine's browser context. Every request: public addresses only (policy.checkHost);
// page navigation only to allowed hosts; writes (anything but GET/HEAD/OPTIONS) only to allowed hosts or known ATS
// upload storage, and never in dry run. One exception for scoring runs: allowUploads lets a dry run write to known
// ATS upload storage (isAtsUploadHost), so a résumé can attach while the application itself is never sent.
// Every write is logged, allowed or blocked.
import { isAllowedHost, isAtsUploadHost } from './security.mjs'

/**
 * installGuard(context, { policy, jobUrl, allowedDomains, dryRun, allowUploads })
 * allowedDomains: an array, or a function returning one (it can change during a run).
 * Returns { blocked, sent, log } (the shape session.mjs exposes as ctx.writes).
 */
export async function installGuard(context, { policy, jobUrl, allowedDomains = [], dryRun = false, allowUploads = false }) {
  const writes = { blocked: 0, sent: [], log: [] }
  const extra = () => (typeof allowedDomains === 'function' ? allowedDomains() : allowedDomains) || []
  await context.route('**/*', async route => {
    const request = route.request()
    let target
    try { target = new URL(request.url()) } catch { return route.abort() }
    if (!['http:', 'https:'].includes(target.protocol)) return route.continue()
    const method = request.method()
    const entry = WRITE(method) ? { url: target.href.slice(0, 200), method, at: Date.now() } : null
    let d
    try {
      await policy.checkHost(target)
      d = decideRequest({
        method, navigation: request.isNavigationRequest(), dryRun, allowUploads,
        allowedHost: isAllowedHost(target.hostname, jobUrl, extra()), upload: isAtsUploadHost(target.hostname),
        graphqlRead: WRITE(method) && graphqlRead(request),
      })
    } catch (error) {
      d = { allow: false, why: String(error.message).slice(0, 80) }
    }
    if (entry) {
      writes.log.push({ ...entry, allowed: d.allow, why: d.why })
      if (!d.allow) writes.blocked++
      else if (d.why !== 'graphql query (read)') writes.sent.push(entry)
    }
    return d.allow ? route.continue() : route.abort()
  })
  return writes
}

const WRITE = method => !['GET', 'HEAD', 'OPTIONS'].includes(method)

/**
 * The guard's rule for one request whose host already passed the public-address check. Pure, so it is tested
 * case by case (scoreboard/lib.test.mjs). Returns { allow, why }.
 * - Navigation: only to allowed hosts.
 * - Reads: allowed.
 * - GraphQL queries (reads sent as POST): allowed on allowed hosts, dry run included.
 * - Writes in a normal run: allowed hosts and known ATS upload storage.
 * - Writes in a dry run: none, except upload storage when allowUploads is set (scoring runs only).
 */
export function decideRequest({ method, navigation = false, allowedHost, upload = false, graphqlRead: gq = false, dryRun, allowUploads = false }) {
  if (navigation && !allowedHost) return { allow: false, why: 'navigation outside allowlist' }
  if (!WRITE(method)) return { allow: true, why: 'read' }
  if (allowedHost && gq) return { allow: true, why: 'graphql query (read)' }
  if (dryRun) return allowUploads && upload ? { allow: true, why: 'upload storage (scoring run)' } : { allow: false, why: 'write in dry run' }
  if (allowedHost) return { allow: true, why: 'allowed host' }
  if (upload) return { allow: true, why: 'upload storage' }
  return { allow: false, why: 'write outside allowlist' }
}

// A POST whose JSON body is one or more GraphQL operations that are all queries (no mutation or subscription).
// Persisted queries without their text cannot be checked and count as writes.
export function graphqlRead(request) {
  if (request.method() !== 'POST' || !/json/i.test(request.headers()['content-type'] || '')) return false
  let body
  try { body = JSON.parse(request.postData() || '') } catch { return false }
  const ops = Array.isArray(body) ? body : [body]
  return ops.length > 0 && ops.every(op => {
    const q = typeof op?.query === 'string' ? op.query.replace(/#[^\n]*/g, '').trim() : ''
    return /^(query\b|\{)/.test(q) && !/(^|[}\s])(mutation|subscription)\s*[\w({]/.test(q)
  })
}

// Dry run: a form's own submit event never fires a real submission, whatever clicked it.
export const blockFormSubmit = page => page.addInitScript(() => { document.addEventListener('submit', e => e.preventDefault(), true) })
