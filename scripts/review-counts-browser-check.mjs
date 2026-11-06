import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './browser-fixture.mjs';
test('thread bubbles show total threads with an unresolved badge and distinguish empty/unavailable counts', async t => {
  const counts = [{ resolved: 1, unresolved: 1, total: 3 }, { resolved: 0, total: 0 }, null, { resolved: 0, unresolved: 0, total: 5 }, { resolved: 3, total: 18 }];
  const items = counts.map((reviewThreadCounts, i) => ({ id: String(i), number: i + 1, title: `Pull ${i}`, repo: 'example/repo', author: 'alice',
    status: 'OPEN', checks: 'NONE', review: 'NONE', labels: [], reviewers: [], commentCount: 7,
    additions: 1, deletions: 0, updatedAt: '2026-10-20T00:00:00Z', createdAt: '2026-10-20T00:00:00Z' }));
  const list = async () => ({ viewer: 'alice', items, total: items.length, pageInfo: { hasNextPage: false } });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  list.reviewCounts = async ids => { await held; return { items: ids.map(id => ({ ...items[Number(id)], reviewThreadCounts: counts[Number(id)] })) }; };
  const { page, origin, errors } = await browserFixture(t, { list }); await page.goto(origin);
  await page.locator('.comment-count').first().waitFor();
  assert.deepEqual(await page.locator('.comment-count').allTextContents(), ['—', '—', '—', '—', '—']);
  assert.match(await page.locator('.comment-count').first().getAttribute('aria-label'), /counts loading/);
  assert.equal(await page.locator('#refresh').isEnabled(), true);
  await page.locator('.edit-title').first().click();
  await page.locator('.title-editor input').fill('Unsaved edit');
  release();
  await page.locator('.comment-unresolved').first().waitFor();
  assert.equal(await page.locator('.title-editor input').inputValue(), 'Unsaved edit');
  assert.equal(await page.locator('.title-editor input').evaluate(el => el === document.activeElement), true);
  const cells = page.locator('.comment-count');
  assert.equal(await cells.nth(0).locator('.comment-unresolved').innerText(), '1');
  assert.equal(await cells.nth(0).locator('.comment-total').innerText(), '3');
  assert.match(await cells.nth(0).getAttribute('aria-label'), /1 unresolved of 3 review threads; 1 unanswered author thread excluded; 7 total comments/);
  assert.equal(await cells.nth(1).innerText(), '—');
  assert.match(await cells.nth(1).getAttribute('data-tooltip'), /No review threads; 7 total comments/);
  assert.equal(await cells.nth(2).innerText(), '—');
  assert.match(await cells.nth(2).getAttribute('data-tooltip'), /counts unavailable/);
  assert.equal(await cells.nth(3).locator('.comment-unresolved').count(), 0);
  assert.equal(await cells.nth(3).locator('.comment-total').innerText(), '5');
  assert.match(await cells.nth(3).getAttribute('aria-label'), /0 unresolved of 5 review threads/);
  assert.match(await cells.nth(3).getAttribute('data-tooltip'), /5 unanswered author threads excluded/);
  assert.equal(await cells.nth(4).locator('.comment-unresolved').innerText(), '15');
  assert.equal(await cells.nth(4).locator('.comment-total').innerText(), '18');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator('.pr-row').evaluateAll(rows => rows.every(row => {
      const badge = row.querySelector('.comment-unresolved');
      return !badge || badge.getBoundingClientRect().left >= row.querySelector('.diff-counts').getBoundingClientRect().right + 4;
    })), true, `Badges must not overlap the diff column at ${width}px`);
  }
  assert.deepEqual(errors, []);
});
