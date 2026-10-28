import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './browser-fixture.mjs';

async function fixture(t) {
  const f = await browserFixture(t, { list: async () => ({ items: [] }) });
  await f.page.route(f.origin + '/', route => route.fulfill({ contentType: 'text/html',
    headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'none'; style-src-attr 'none'" },
    body: '<!doctype html><html><head><title>Template checks</title></head><body></body></html>',
  }));
  await f.page.clock.install();
  await f.page.goto(f.origin);
  return f;
}

test('author hues use CSSOM on initial render, changes and removal under strict CSP', async t => {
  const { page, errors } = await fixture(t);
  const hues = await page.evaluate(async () => {
    const { render } = await import('/vendor/lit-html.js');
    const { usernameLink } = await import('/templates.js');
    const host = document.body.appendChild(document.createElement('div'));
    const values = [];
    for (const hue of [120, 240, undefined]) {
      render(usernameLink('alice', 'badge author', hue), host);
      values.push(getComputedStyle(host.querySelector('a')).getPropertyValue('--author-hue').trim());
    }
    return values;
  });
  assert.deepEqual(hues, ['120', '240', '']);
  assert.deepEqual(errors, []);
});

test('clipboard feedback keeps Lit icon expressions mounted and updateable', async t => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => {
    const { html, render } = await import('/vendor/lit-html.js');
    const { copyFeedback, iconTemplate } = await import('/templates.js');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} } });
    const host = document.body.appendChild(document.createElement('div'));
    window.draw = name => render(html`<div class="pr-row"><button data-tooltip="Copy" ${copyFeedback('text', 'Copied', 'Copy')}>
      <span class="copy-symbol">${iconTemplate(name)}</span><span class="copy-feedback-symbol" hidden></span>
      </button><span role="status"></span></div>`, host);
    window.draw('copy');
    window.symbol = host.querySelector('.copy-symbol');
    window.marker = window.symbol.firstChild;
  });
  await page.click('button');
  await page.waitForFunction(() => document.querySelector('.copy-feedback-symbol').textContent === '✓');
  await page.evaluate(() => window.draw('edit'));
  assert.equal(await page.evaluate(() => window.symbol.firstChild === window.marker && window.marker.isConnected && window.symbol.hidden), true);
  assert.equal(await page.locator('.copy-symbol svg path').getAttribute('d'), 'M10 3l3 3M2 11l-1 4 4-1L14 5a2.12 2.12 0 0 0-3-3Z');
  await page.clock.fastForward(2000);
  assert.equal(await page.locator('.copy-symbol').evaluate(el => el.hidden), false);
  assert.equal(await page.locator('.copy-feedback-symbol').evaluate(el => el.hidden), true);
  assert.equal(await page.locator('button').getAttribute('data-tooltip'), 'Copy');
  assert.deepEqual(errors, []);
});


test('age effects use daily color, weekly background and six-hour saturation and brightness, clamps future dates, and refreshes under strict CSP', async t => {
  const { page, errors } = await fixture(t);
  const values = await page.evaluate(async () => {
    const { html, render } = await import('/vendor/lit-html.js');
    const { ageTint } = await import('/templates.js');
    const host = document.body.appendChild(document.createElement('div'));
    const now = Date.UTC(2026, 9, 27);
    return [-1, 0, 0.25, 0.5, 1, NaN].map(days => {
      render(html`<time ${ageTint(now - days * 86400000, now)}>Age</time>`, host);
      const style = host.firstElementChild.style;
      return ['--age-tint', '--age-saturation', '--age-brightness', '--age-background'].map(name => style.getPropertyValue(name));
    });
  });
  assert.deepEqual(values, [
    ['100.000%', '1.0000', '1.0000', '100.000%'], ['100.000%', '1.0000', '1.0000', '100.000%'],
    ['84.090%', '0.5000', '0.8500', '97.555%'], ['70.711%', '0.2500', '0.7750', '95.170%'],
    ['50.000%', '0.0625', '0.7188', '90.572%'], ['0.000%', '0.0000', '0.7000', '0.000%'],
  ]);
  assert.deepEqual(errors, []);
});

test('reviewer initials distinguish single-part names and identify team slugs', async t => {
  const { page } = await fixture(t);
  const initials = await page.evaluate(async () => {
    const { render } = await import('/vendor/lit-html.js');
    const { reviewerAvatar } = await import('/templates.js');
    const host = document.body.appendChild(document.createElement('div'));
    return [['alex', 'user'], ['maya', 'user'], ['org/core', 'team'], ['octo_cat', 'user'], ['dependabot[bot]', 'bot']].map(([name, kind]) => {
      render(reviewerAvatar(name, 'APPROVED', 120, kind), host);
      return host.textContent;
    });
  });
  assert.deepEqual(initials, ['AL', 'MA', 'CO', 'OC', 'DE']);
});
