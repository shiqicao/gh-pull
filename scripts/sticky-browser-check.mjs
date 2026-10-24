import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './browser-fixture.mjs';

const items = Array.from({ length: 36 }, (_, i) => ({
  id: `sticky-${i}`, number: i + 1, title: `Improve pull request workflow ${i + 1}`,
  url: `https://github.com/example/dashboard/pull/${i + 1}`,
  repo: i < 18 ? 'example/dashboard' : 'example/extension', author: 'alice',
  status: 'OPEN', branch: `feature/${i}`, baseBranch: 'main',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T01:00:00Z',
  additions: 20, deletions: 4, changedFiles: 2, commentCount: 3,
  review: 'NONE', checks: 'SUCCESS', reviewers: [], labels: [],
}));

test('title and filters stay pinned; group headings hand off below the responsive top', async t => {
  const list = async () => ({ viewer: 'alice', total: items.length, items, pageInfo: { hasNextPage: false } });
  list.viewer = async () => 'alice';
  const { page, origin, errors } = await browserFixture(t, { list, savedViews: { list: async () => [] } });
  await page.goto(origin);
  await page.locator('.pr-row').first().waitFor();
  for (const [width, height, zoom] of [[1280, 900, 1], [375, 1000, 1], [1280, 900, 1.5], [1000, 1000, 2], [375, 600, 1]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(zoom => { document.documentElement.style.zoom = zoom; window.scrollTo(0, 0); }, zoom);
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-top-height')) - document.querySelector('#sticky-top').offsetHeight) < 1);
    for (const index of [0, 1]) {
      await page.locator('.pr-group').nth(index).evaluate(group => window.scrollTo(0, window.scrollY + group.getBoundingClientRect().top + 100));
      await page.waitForFunction(index => {
        const top = document.querySelector('#sticky-top').getBoundingClientRect();
        const heading = document.querySelectorAll('.pr-group > summary')[index].getBoundingClientRect();
        return Math.abs(heading.top - top.bottom) < 2;
      }, index);
      if (index === 0) await page.screenshot({ path: `/tmp/gh-pull-sticky-${width}-${height}-${zoom}.png` });
      const bounds = await page.evaluate(index => {
        const top = document.querySelector('#sticky-top').getBoundingClientRect();
        const heading = document.querySelectorAll('.pr-group > summary')[index].getBoundingClientRect();
        return { top: top.top, bottom: top.bottom, headingBottom: heading.bottom, height: innerHeight,
          hit: document.elementFromPoint(heading.left + 40, heading.top + 15)?.closest('summary') !== null,
          overflow: document.documentElement.scrollWidth > innerWidth };
      }, index);
      assert.ok(bounds.top <= 1);
      assert.ok(bounds.headingBottom < bounds.height, 'PR content remains reachable on short screens');
      assert.equal(bounds.overflow, false);
      assert.equal(bounds.hit, true, 'heading is above rows and dependency connectors');
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.style.zoom = 1; });
  // A notice can appear after scrolling; the group offset must follow its new height.
  await page.evaluate(() => { const notice = document.querySelector('#auth-notice'); notice.textContent = 'Connection notice'; notice.hidden = false; });
  await page.waitForFunction(() => Math.abs(document.querySelectorAll('.pr-group > summary')[1].getBoundingClientRect().top - document.querySelector('#sticky-top').getBoundingClientRect().bottom) < 2);
  await page.locator('.pr-group > summary').nth(1).click();
  assert.equal(await page.locator('.pr-group').nth(1).getAttribute('open'), null);
  await page.locator('.pr-group > summary').nth(1).click();
  await page.evaluate(() => { document.querySelector('#auth-notice').hidden = true; });
  await page.locator('.pr-group').first().evaluate(group => window.scrollTo(0, window.scrollY + group.getBoundingClientRect().top + 160));
  await page.screenshot({ path: '/tmp/gh-pull-sticky-preview.png' });
  await page.locator('#group').selectOption('none');
  assert.equal(await page.locator('.pr-group').count(), 1);
  assert.match(await page.locator('.pr-group > summary').innerText(), /All pull requests/);
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForFunction(() => Math.abs(document.querySelector('#sticky-top').getBoundingClientRect().top) < 1);
  assert.deepEqual(errors, []);
});
