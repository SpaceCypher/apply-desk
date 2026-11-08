// Labels and option groups the way a person reads a form. Lever (markup copied from jobs.lever.co) lists options
// under a question heading with no fieldset, and its custom "card" fields carry only a placeholder. Needs a Chromium.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { observe } from './perception/walk.mjs'
import { questions } from '../../scoreboard/lib.mjs'

const LEVER = `<!doctype html><body><form><ul>
<li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div>
  <div class="application-field"><input type="text" name="name" required></div></label></li>
<li class="application-question custom-question"><div><div class="application-label full-width multiple-select"><div class="text">Language Skill(s) (Check all that apply)<span class="required">✱</span></div></div>
  <div class="application-field full-width required-field"><ul data-qa="checkboxes">
    <li><label><input type="checkbox" name="cards[a69a][field0]" value="English (ENG)"><span class="application-answer-alternative">English (ENG)</span></label></li>
    <li><label><input type="checkbox" name="cards[a69a][field0]" value="Spanish (SPA)"><span class="application-answer-alternative">Spanish (SPA)</span></label></li>
    <li><label><input type="checkbox" name="cards[a69a][field0]" value="Hindi (HIN)"><span class="application-answer-alternative">Hindi (HIN)</span></label></li>
  </ul></div></div></li>
<li class="application-question custom-question"><div><div class="application-label full-width"><div class="text">Are you open to relocating to London?<span class="required">✱</span></div></div>
  <div class="application-field full-width required-field"><ul data-qa="multiple-choice">
    <li><label><input type="radio" name="cards[1c71][field0]" value="Yes" required><span class="application-answer-alternative">Yes</span></label></li>
    <li><label><input type="radio" name="cards[1c71][field0]" value="No" required><span class="application-answer-alternative">No</span></label></li>
  </ul></div></div></li>
<li class="application-question custom-question"><div><div class="application-label full-width text"><div class="text">Current CTC<span class="required">✱</span></div></div>
  <div class="application-field full-width required-field"><input required class="card-field-input" type="text" placeholder="Type your response" name="cards[a8fe][field0]"></div></div></li>
<li class="application-question custom-question"><div><div class="application-label full-width text"><div class="text">Expected CTC<span class="required">✱</span></div></div>
  <div class="application-field full-width required-field"><input required class="card-field-input" type="text" placeholder="Type your response" name="cards[a8fe][field1]"></div></div></li>
<li class="application-question custom-question"><div><div class="application-label"><div class="text">Privacy notice</div></div>
  <div class="application-field"><ul><li><label><input type="checkbox" name="cards[b2][field0]" value="I agree"><span>I agree</span></label></li></ul></div></div></li>
</ul>
<div class="block"><input type="text" name="unlabelled_next_to_others" placeholder="Website"><input type="text" name="other" placeholder="Other"></div>
<fieldset><legend>Pronouns</legend><label><input type="radio" name="p" value="she"> She/her</label><label><input type="radio" name="p" value="he"> He/him</label></fieldset>
<div class="opts"><input type="checkbox" id="o1" name="opt"><label for="o1">Option A</label><input type="checkbox" id="o2" name="opt"><label for="o2">Option B</label></div>
</form></body>`

test('Lever: options are grouped under their question, card fields take the question as their label', async t => {
  let browser
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }) } catch { return t.skip('no Playwright Chromium installed') }
  try {
    const page = await browser.newPage()
    await page.setContent(LEVER)
    const obs = await observe(page, { maxElements: 100 })
    const labels = obs.elements.map(e => e.label)
    for (const l of ['Language Skill(s) (Check all that apply) > English (ENG)', 'Language Skill(s) (Check all that apply) > Hindi (HIN)',
      'Are you open to relocating to London? > Yes', 'Are you open to relocating to London? > No', 'Current CTC', 'Expected CTC',
      'Privacy notice > I agree', 'Pronouns > She/her'])
      assert.ok(labels.includes(l), `missing "${l}" in ${JSON.stringify(labels)}`)
    assert.ok(!labels.some(l => /Type your response|cards\[/.test(l)), 'no placeholder or field-name labels')
    // A field sharing its box with other fields never borrows a heading; it keeps its placeholder.
    assert.ok(labels.includes('Website'))
    // Option labels (<label for>) are options, not the question.
    assert.ok(labels.includes('Option A') && labels.includes('Option B'))

    const qs = questions(obs)
    const lang = qs.find(q => q.label === 'Language Skill(s) (Check all that apply)')
    assert.equal(lang.kind, 'checks'); assert.deepEqual(lang.options, ['English (ENG)', 'Spanish (SPA)', 'Hindi (HIN)'])
    const reloc = qs.find(q => q.label === 'Are you open to relocating to London?')
    assert.equal(reloc.kind, 'radio'); assert.deepEqual(reloc.options, ['Yes', 'No']); assert.equal(reloc.required, true)
    assert.equal(qs.filter(q => /Language Skill|relocating/.test(q.label)).length, 2, 'one question per group')
  } finally {
    await browser.close()
  }
})
