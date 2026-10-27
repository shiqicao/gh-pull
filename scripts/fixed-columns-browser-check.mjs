import test from 'node:test';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import { browserFixture } from './browser-fixture.mjs';

test('fixed columns align, preserve reviewer identities and statuses, and adapt to narrow screens', async t => {
  const base = { id: 'one', number: 1, title: 'Short title', repo: 'example/dashboard', author: 'alice', status: 'OPEN', checks: 'SUCCESS', review: 'APPROVED', labels: [], branch: 'feature/short', additions: 12, deletions: 3, changedFiles: 2, commentCount: 3, reviewThreadCounts: { resolved: 2, total: 3 }, updatedAt: new Date().toISOString(), createdAt: '2026-10-01', url: 'https://github.com/example/dashboard/pull/1', reviewers: [{ name: 'bot', kind: 'bot', state: 'COMMENTED' }, { name: 'bob', state: 'APPROVED' }, { name: 'carol', state: 'REQUESTED' }, { name: 'dana', state: 'CHANGES_REQUESTED' }] };
  const list = async () => ({ viewer: 'alice', items: [base, { ...base, id: 'two', number: 12345, title: 'A much longer title that must not push the other columns out of alignment '.repeat(3), branch: 'feature/'.repeat(30), additions: 99999 }], total: 2, pageInfo: { hasNextPage: false } });
  list.reviewCounts = async ids => ({ items: ids.map(id => ({ ...base, id, reviewThreadCounts: { resolved: 2, total: 3 } })) });
  const { page, origin, errors } = await browserFixture(t, { list });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(origin); await page.locator('.pr-row').first().waitFor();
  const selectors = ['.pr-identity', '.pr-title-cell', '.pr-ci', '.pr-review', '.diff-counts', '.comment-count', '.updated-time', '.reviewers'];
  for (const selector of selectors) {
    const lefts = await page.locator(`.pr-row ${selector}`).evaluateAll(nodes => nodes.map(el => el.getBoundingClientRect().left));
    assert.equal(lefts[0], lefts[1], selector);
  }
  assert.deepEqual(await page.locator('.pr-row').first().locator('.reviewer').evaluateAll(nodes => nodes.map(el => el.getAttribute('title').split(':')[0])), ['dana', 'carol', 'bot', 'bob']);
  assert.equal(await page.locator('.pr-row').first().locator('.reviewer-square').count(), 1);
  await page.waitForFunction(() => document.querySelector('.comment-count').textContent === '2/3');
  assert.equal(await page.locator('.pr-row').nth(1).locator('.pr-title').getAttribute('title'), 'A much longer title that must not push the other columns out of alignment '.repeat(3));
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    assert.deepEqual((await new AxeBuilder({ page }).include('.pr-list').analyze()).violations, []);
    for (const [width, zoom] of [[1280, 1], [1280, 1.5], [390, 1], [320, 1]]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(zoom => { document.documentElement.style.zoom = zoom; }, zoom);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width} at ${zoom}`);
    }
    await page.evaluate(() => { document.documentElement.style.zoom = 1; });
    await page.setViewportSize({ width: 1280, height: 1000 });
  }
  assert.deepEqual(errors, []);
});
