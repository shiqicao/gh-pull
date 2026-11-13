import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './browser-fixture.mjs';

test('browser default text size scales controls and rows without horizontal overflow', async t => {
  const pr = { id: 'scale', number: 1234, title: 'Keep keyboard navigation usable with larger text',
    url: 'https://github.com/example/dashboard/pull/1234', repo: 'example/dashboard', author: 'alice',
    status: 'OPEN', branch: 'feature/keyboard-navigation', checks: 'SUCCESS', review: 'CHANGES_REQUESTED',
    additions: 1234, deletions: 567, changedFiles: 12, commentCount: 12,
    reviewThreadCounts: { total: 12, resolved: 2 },
    reviewers: [{ name: 'bob', state: 'APPROVED' }], labels: [],
    createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  const { page, origin, errors } = await browserFixture(t, {
    list: async () => ({ viewer: 'alice', items: [pr], total: 1, pageInfo: { hasNextPage: false } }),
  });
  const cdp = await page.context().newCDPSession(page);
  for (const size of [16, 32]) {
    await cdp.send('Page.setFontSizes', { fontSizes: { standard: size, fixed: size } });
    for (const width of [1280, 640, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin);
      await page.locator('.pr-row').waitFor();
      const metrics = await page.evaluate(() => ({
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
        body: parseFloat(getComputedStyle(document.body).fontSize),
        title: parseFloat(getComputedStyle(document.querySelector('.pr-title')).fontSize),
        query: parseFloat(getComputedStyle(document.querySelector('.cm-content')).fontSize),
        width: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && e.getBoundingClientRect().width).map(e => e.className).slice(0, 15),
      }));
      assert.equal(metrics.root, size);
      assert.equal(metrics.body, size * .875);
      assert.equal(metrics.title, size * .875);
      assert.equal(metrics.query, size * .8125);
      assert.ok(metrics.width <= width, JSON.stringify({ size, width, ...metrics }));
      await page.screenshot({ path: `/tmp/gh-pull-text-${size}-${width}.png`, fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
});
