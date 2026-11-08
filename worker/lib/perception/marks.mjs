// Set-of-Marks screenshot: numbered boxes drawn over each observed element so the model's refs match
// what it sees. The overlay ignores pointer events and is removed right after the screenshot.
const OVERLAY_ID = '__agent_marks__'

export async function screenshotWithMarks(page, obs, { marks = true } = {}) {
  const boxes = marks ? obs.elements.filter(e => e.rect.w > 0 && e.inView).map(e => ({ ref: e.ref, ...e.rect, field: e.role !== 'button' && e.role !== 'link' })) : []
  if (boxes.length) {
    await page.evaluate(({ id, boxes }) => {
      const root = document.createElement('div')
      root.id = id
      root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
      for (const b of boxes) {
        const box = document.createElement('div')
        const color = b.field ? '#e8590c' : '#1971c2'
        box.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;outline:2px solid ${color};outline-offset:1px`
        const tag = document.createElement('span')
        tag.textContent = b.ref
        tag.style.cssText = `position:absolute;left:-2px;top:-15px;background:${color};color:#fff;font:600 11px/13px monospace;padding:0 3px;border-radius:2px`
        box.appendChild(tag); root.appendChild(box)
      }
      document.documentElement.appendChild(root)
    }, { id: OVERLAY_ID, boxes }).catch(() => {})
  }
  try {
    return await screenshot(page, obs)
  } finally {
    if (boxes.length) await page.evaluate(id => document.getElementById(id)?.remove(), OVERLAY_ID).catch(() => {})
  }
}

// Plain screenshot with every password field masked, in every observed frame.
export async function screenshot(page, obs) {
  const frames = obs?.frames || [page.mainFrame()]
  const mask = frames.map(f => f.locator('input[type=password]'))
  return page.screenshot({ type: 'png', fullPage: false, mask }).catch(() => null)
}
