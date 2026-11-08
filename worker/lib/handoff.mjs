import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

// CAPTCHA handoff: x11vnc shares the Xvfb display, websockify serves noVNC, and a Cloudflare quick
// tunnel exposes it. The VNC password is one-time. Everything is torn down when the user finishes.
export async function startHandoff({ display = process.env.DISPLAY || ':99', onUrl }) {
  const password = randomBytes(6).toString('hex')
  const procs = []
  const run = (cmd, args) => { const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(p); return p }
  run('x11vnc', ['-display', display, '-forever', '-shared', '-rfbport', '5900', '-passwd', password, '-localhost', '-quiet'])
  run('websockify', ['--web', '/usr/share/novnc', '6080', 'localhost:5900'])
  const tunnel = run('cloudflared', ['tunnel', '--no-autoupdate', '--url', 'http://localhost:6080'])
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tunnel did not start')), 30000)
    const scan = chunk => {
      const m = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (m) { clearTimeout(timer); resolve(m[0]) }
    }
    tunnel.stderr.on('data', scan); tunnel.stdout.on('data', scan)
    tunnel.on('exit', () => reject(new Error('cloudflared exited')))
  }).catch(error => { stop(); throw error })
  function stop() { for (const p of procs) p.kill('SIGTERM') }
  const link = `${url}/vnc.html?autoconnect=1&resize=scale`
  await onUrl(link, password)
  return { stop, link, password }
}
