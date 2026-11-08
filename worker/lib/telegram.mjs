// Telegram Bot API helpers. TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID come from secrets.
async function call(method, body, fetchImpl = fetch) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return null
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Telegram ${method} failed with ${response.status}`)
  return (await response.json()).result
}

export const notify = async (text, buttons) => call('sendMessage', {
  chat_id: process.env.TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true,
  ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
}).catch(error => console.error(error.message))

// buttons: [[{text, callback_data}]]. callback_data is "a:<questionId>:<index>" and handled by /api/telegram.
export function optionButtons(questionId, options) {
  return options.slice(0, 8).map((option, index) => [{ text: String(option).slice(0, 60), callback_data: `a:${questionId}:${index}` }])
}

export async function sendPhoto(buffer, caption, fetchImpl = fetch) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  const form = new FormData()
  form.set('chat_id', process.env.TELEGRAM_CHAT_ID)
  form.set('caption', caption.slice(0, 1000))
  form.set('photo', new Blob([buffer], { type: 'image/png' }), 'page.png')
  await fetchImpl(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form }).catch(() => {})
}
