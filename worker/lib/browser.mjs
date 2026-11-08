// Real Google Chrome in production (channel "chrome"). CHROMIUM_PATH overrides it for local tests.
export function browserOptions(headless) {
  return process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, headless } : { channel: 'chrome', headless }
}
