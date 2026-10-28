import { chromium } from 'playwright';
import { createApp } from '../server.js';

// Tests provide all GitHub behavior. Block every non-fixture browser request.
export async function browserFixture(t, options) {
  const server = createApp(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => {
    // Stop EventSource reconnects before closing the server, including failed tests.
    try { await browser?.close(); } finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  });
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (/Content Security Policy|Refused to|violates.*directive/i.test(message.text())) errors.push(message.text());
  });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  return { page, origin, errors };
}
