import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './browser-fixture.mjs';
test('review ratios have an accessible explanation and zero/unavailable threads use comment totals', async t => {
  const counts = [{ resolved: 2, total: 3 }, { resolved: 0, total: 0 }, null];
  const items = counts.map((reviewThreadCounts, i) => ({ id: String(i), number: i + 1, title: `Pull ${i}`, repo: 'example/repo', author: 'alice',
    status: 'OPEN', checks: 'NONE', review: 'NONE', labels: [], reviewers: [], commentCount: 7,
    additions: 1, deletions: 0, updatedAt: '2026-10-20T00:00:00Z', createdAt: '2026-10-20T00:00:00Z' }));
  const list = async () => ({ viewer: 'alice', items, total: 3, pageInfo: { hasNextPage: false } });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  list.reviewCounts = async ids => { await held; return { items: ids.map(id => ({ ...items[Number(id)], reviewThreadCounts: counts[Number(id)] })) }; };
  const { page, origin, errors } = await browserFixture(t, { list }); await page.goto(origin);
  await page.locator('.comment-count').first().waitFor();
  assert.deepEqual(await page.locator('.comment-count').allTextContents(), ['7', '7', '7']);
  assert.equal(await page.locator('#refresh').isEnabled(), true);
  await page.locator('.edit-title').first().click();
  await page.locator('.title-editor input').fill('Unsaved edit');
  release();
  await page.waitForFunction(() => document.querySelector('.comment-count')?.textContent === '2/3');
  assert.equal(await page.locator('.title-editor input').inputValue(), 'Unsaved edit');
  assert.equal(await page.locator('.title-editor input').evaluate(el => el === document.activeElement), true);
  assert.deepEqual(await page.locator('.comment-count').allTextContents(), ['2/3', '7', '7']);
  assert.match(await page.locator('.comment-count').first().getAttribute('aria-label'), /2 of 3 review threads resolved; 7 total comments/);
  assert.match(await page.locator('.comment-count').last().getAttribute('data-tooltip'), /unavailable/);
  assert.deepEqual(errors, []);
});
