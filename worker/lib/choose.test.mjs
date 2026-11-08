import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { chooseOption } from './agent.mjs'

// Workday-like country button: the list renders only the first 20 options until you type, like a long virtual list.
const PAGE = `<!doctype html><body>
<button id="country" aria-haspopup="listbox">United States of America</button>
<ul id="list" role="listbox" hidden style="max-height:120px;overflow:auto"></ul>
<script>
const all = ['Afghanistan','Albania','Algeria','Andorra','Angola','Argentina','Armenia','Australia','Austria','Azerbaijan','Bahamas','Bahrain','Bangladesh','Belarus','Belgium','Belize','Benin','Bhutan','Bolivia','Brazil','Canada','China','France','Germany','India','Indonesia','Japan','United States of America']
let typed = ''
const list = document.getElementById('list'), button = document.getElementById('country')
const render = () => { list.innerHTML = all.filter(c => c.toLowerCase().startsWith(typed)).slice(0, 20).map(c => '<li role="option">' + c + '</li>').join('') }
button.onclick = () => { typed = ''; render(); list.hidden = !list.hidden }
addEventListener('keydown', e => { if (!list.hidden && e.key.length === 1) { typed += e.key.toLowerCase(); render() } })
list.onclick = e => { if (e.target.role === 'option') { button.textContent = e.target.textContent; list.hidden = true } }
</script></body>`

test('chooseOption picks an option that is only rendered after typing', async t => {
  let browser
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }) } catch { return t.skip('no Playwright Chromium installed') }
  try {
    const page = await browser.newPage()
    await page.setContent(PAGE)
    const button = page.locator('#country')
    assert.equal(await chooseOption(page, button, 'India'), true)
    assert.equal(await button.innerText(), 'India')
    assert.equal(await chooseOption(page, button, 'India'), true, 'already chosen is a no-op')
    assert.equal(await chooseOption(page, button, 'Atlantis'), false, 'a missing option reports failure')
    assert.equal(await page.locator('#list').isHidden(), true, 'a failed attempt closes the list')
  } finally {
    await browser.close()
  }
})

// react-select as on Greenhouse: typing filters, Enter picks the first match, the value shows beside the input.
const REACT_SELECT = `<!doctype html><body>
<div class="application--select-field">
<label for="q">Do you require visa sponsorship, now or in the future?</label>
<div class="select__control"><div class="select__value-container">
  <div class="select__single-value" id="val">Select...</div>
  <input id="q" role="combobox" aria-expanded="false">
</div></div>
</div>
<div id="menu" hidden></div>
<script>
const opts = ['Yes', 'No'], q = document.getElementById('q'), menu = document.getElementById('menu')
const show = () => { const f = opts.filter(o => o.toLowerCase().startsWith(q.value.toLowerCase())); menu.innerHTML = f.map(o => '<div class="select__option">' + o + '</div>').join(''); menu.hidden = false; return f }
q.onfocus = show; q.oninput = show
q.onkeydown = e => { if (e.key === 'Enter') { const f = show(); if (f.length) { document.getElementById('val').textContent = f[0]; q.value = ''; menu.hidden = true } } }
</script></body>`

test('chooseOption sees a react-select value shown beside the input', async t => {
  let browser
  try { browser = await chromium.launch() } catch { return t.skip('no Playwright Chromium installed') }
  try {
    const page = await browser.newPage()
    await page.setContent(REACT_SELECT)
    const input = page.locator('#q')
    assert.equal(await chooseOption(page, input, 'No'), true)
    assert.equal(await page.locator('#val').innerText(), 'No')
    assert.equal(await chooseOption(page, input, 'No'), true, 'already chosen is a no-op')
  } finally {
    await browser.close()
  }
})

// Greenhouse's school field: a search box whose results come from the server after a delay. The first default
// option ("Aarhus University") is highlighted, so pressing Enter before the results arrive picks the wrong school.
const ASYNC_SEARCH = `<!doctype html><body>
<label for="s">School</label>
<div class="select__control"><div class="select__value-container">
  <div class="select__single-value" id="val">Select...</div>
  <input id="s" role="combobox" aria-activedescendant="o0">
</div></div>
<div id="menu" role="listbox"></div>
<script>
const all = ['Aarhus University', 'Aalto University', 'State University', 'Purdue University']
const s = document.getElementById('s'), menu = document.getElementById('menu'), val = document.getElementById('val')
let shown = all.slice(0, 2), timer
const draw = () => { menu.innerHTML = shown.map((o, i) => '<div role="option" id="o' + i + '">' + o + '</div>').join(''); s.setAttribute('aria-activedescendant', 'o0') }
const pick = o => { val.textContent = o; s.value = ''; menu.innerHTML = '' }
s.onfocus = draw
s.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { shown = all.filter(o => o.toLowerCase().includes(s.value.toLowerCase())); draw() }, 1500) }
s.onkeydown = e => { if (e.key === 'Enter' && shown.length) pick(shown[0]) }
menu.onclick = e => { if (e.target.getAttribute('role') === 'option') pick(e.target.textContent) }
</script></body>`

test('chooseOption waits for server search results and never picks the highlighted wrong option', async t => {
  let browser
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }) } catch { return t.skip('no Playwright Chromium installed') }
  try {
    const page = await browser.newPage()
    await page.setContent(ASYNC_SEARCH)
    assert.equal(await chooseOption(page, page.locator('#s'), 'State University'), true)
    assert.equal(await page.locator('#val').innerText(), 'State University')
    await page.setContent(ASYNC_SEARCH)
    assert.equal(await chooseOption(page, page.locator('#s'), 'Nowhere College'), false, 'no match reports failure')
    assert.equal(await page.locator('#val').innerText(), 'Select...', 'and selects nothing, not Aarhus University')
  } finally {
    await browser.close()
  }
})

// Greenhouse nests the query input inside its own container; the selection is a sibling of that container.
const GREENHOUSE = `<!doctype html><body><label for="q">Degree</label>
<div class="select__control"><div class="select__value-container"><div class="select__single-value" id="val"></div><div class="select__input-container"><input id="q" role="combobox" aria-controls="menu"></div></div></div>
<div id="menu" role="listbox" hidden></div><script>
const q=document.getElementById('q'), menu=document.getElementById('menu'), val=document.getElementById('val');
let options=["Bachelor's Degree", "Master's Degree"], timer;
const draw=()=>{menu.hidden=false;menu.innerHTML=options.filter(x=>x.toLowerCase().includes(q.value.toLowerCase())).map(x=>'<div role="option">'+x+'</div>').join('')};
q.onfocus=draw;q.onclick=draw;q.oninput=()=>{clearTimeout(timer);timer=setTimeout(draw,1500)};
menu.onmousedown=e=>e.preventDefault();menu.onclick=e=>{if(e.target.role==='option'){if(!window.reject)val.textContent=e.target.textContent;q.value='';menu.hidden=true}};
q.onkeydown=e=>{if(e.key==='Escape'){q.value='';menu.hidden=true}};
window.setOptions=xs=>{options=xs};
</script>`

test('Greenhouse: degree wording, expanded yes/no, selection after blur and perception', async t => {
  let browser
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }) } catch { return t.skip('no Playwright Chromium installed') }
  try {
    const page = await browser.newPage()
    await page.setContent(GREENHOUSE)
    const input = page.locator('#q')
    assert.equal(await chooseOption(page, input, 'B.Tech'), true)
    await input.blur()
    await input.evaluate(e => { e.style.opacity = '0'; e.style.width = '1px' })
    assert.equal(await page.locator('#val').innerText(), "Bachelor's Degree")
    const { observe } = await import('./perception/walk.mjs')
    assert.equal((await observe(page)).elements.find(e => e.role === 'combobox').value, "Bachelor's Degree")
    await input.evaluate(e => { e.style.opacity = '1'; e.style.width = '150px' })
    await page.evaluate(() => { document.getElementById('val').textContent = ''; setOptions(['Yes, I am authorized', 'No, I need authorization']) })
    assert.equal(await chooseOption(page, input, 'Yes'), true)
    assert.equal(await page.locator('#val').innerText(), 'Yes, I am authorized')
    await page.evaluate(() => { document.getElementById('val').textContent = ''; setOptions(['State University North', 'State University South']) })
    assert.equal(await chooseOption(page, input, 'State University'), false, 'ambiguous campuses require the owner')
    assert.equal(await page.locator('#val').innerText(), '')
    await page.evaluate(() => { document.getElementById('val').textContent = 'State University North' })
    assert.equal(await chooseOption(page, input, 'State University'), false, 'a preselected campus is not a whole-line match')
    await page.evaluate(() => { document.getElementById('val').textContent = ''; setOptions(['State Institute']); document.getElementById('q').value = '' })
    assert.equal(await chooseOption(page, input, 'State University'), false, 'first-word overlap is not a match')
    await page.evaluate(() => { setOptions(['Yes']); window.reject = true })
    assert.equal(await chooseOption(page, input, 'Yes'), false, 'a click alone does not prove selection')
    await page.evaluate(() => { window.reject = false; document.getElementById('q').onblur = () => { document.getElementById('val').textContent = '' } })
    assert.equal(await chooseOption(page, input, 'Yes'), false, 'a selection cleared on blur is a failure')
    await input.fill('Yes')
    assert.equal((await observe(page)).elements.find(e => e.role === 'combobox').value, '', 'search text is not a selected answer')
  } finally { await browser.close() }
})


test('Greenhouse: a portalled menu in the input iframe ignores other documents', async t => {
  let browser
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }) } catch { return t.skip('no Playwright Chromium installed') }
  try {
    const page = await browser.newPage()
    await page.setContent('<div role="option">Yes, wrong document</div><iframe></iframe>')
    const frame = page.frames()[1]
    await frame.setContent(GREENHOUSE)
    await frame.evaluate(() => setOptions(['Yes, I am authorized', 'No']))
    assert.equal(await chooseOption(page, frame.locator('#q'), 'Yes'), true)
    assert.equal(await frame.locator('#val').innerText(), 'Yes, I am authorized')
  } finally { await browser.close() }
})
