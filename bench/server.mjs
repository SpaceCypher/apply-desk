// Serves bench/fixtures on 127.0.0.1. Counts every write request: in dry run there must be none.
import http from 'node:http'
import { readFile } from 'node:fs/promises'

export async function startFixtureServer(dir = new URL('./fixtures/', import.meta.url)) {
  const writes = []
  const server = http.createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { writes.push({ method: req.method, url: req.url }); res.end('<h1>Thank you for applying!</h1>'); return }
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1)) || 'index.html'
      if (name.includes('..')) throw new Error('bad path')
      res.setHeader('content-type', name.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8')
      res.end(await readFile(new URL(name, dir)))
    } catch { res.statusCode = 404; res.end('not found') }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/`, writes, close: () => new Promise(r => server.close(r)) }
}
