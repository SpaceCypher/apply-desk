import test from 'node:test'
import assert from 'node:assert/strict'
import { extractVerification } from './mail.mjs'

const greenhouse = code => `Thank you for your interest in Example Corp.

To finish submitting your application, please enter the following security code on the application page. This helps us verify your email address and protect your application. The code will expire in 10 minutes.

${code}

If you did not request this code, you can ignore this email.
Greenhouse Recruiting`

test('Greenhouse security email extracts eight characters beyond the old 40-character window', () => {
  for (const code of ['AB12CD34', 'ab12cd34', '82719463', 'QWERTYZX']) {
    assert.equal(extractVerification(greenhouse(code)).code, code)
    assert.equal(extractVerification('', greenhouse(code).split('\n').map(line => `<p>${line}</p>`).join('')).code, code)
  }
  assert.equal(extractVerification('Your security code: A1B2C3D4').code, 'A1B2C3D4')
})

test('years, phones and order numbers are not eight-character verification codes', () => {
  for (const body of ['Year: 2026', 'Phone: 12345678', 'Order number: 123456', 'Phone: 5551234567', 'Order number:\n12345678',
    'Your verification code will arrive separately.\nOrder number:\n12345678',
    'Your security code will arrive separately.\nPhone: 12345678', 'Application reference:\nAB12CD34']) {
    assert.equal(extractVerification(body).code, null, body)
  }
  assert.equal(extractVerification('Your verification code is 123456').code, '123456')
})
