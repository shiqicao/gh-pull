import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../github.js';
import { browserFixture } from './browser-fixture.mjs';

test('own approval menu confirms, preserves errors and updates dismissed state', async t => {
  let pr = { id: 'PR_1', number: 123, title: 'Improve repository search suggestions', repo: 'example/dashboard',
    url: 'https://github.com/example/dashboard/pull/123', author: 'bob', status: 'OPEN', checks: 'SUCCESS', review: 'APPROVED', labels: [],
    additions: 24, deletions: 8, branch: 'feature/search', createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z',
    reviewers: [{ name: 'alice', state: 'APPROVED', reviewId: 'R_1', reviewUrl: 'https://github.com/example/dashboard/pull/123#pullrequestreview-1', canRevoke: true }] };
  const list = async () => ({ viewer: 'alice', items: [pr], total: 1, pageInfo: { hasNextPage: false } });
  list.status = async () => ({ items: [pr] });
  let calls = 0;
  list.dismissReview = async input => {
    calls++; assert.deepEqual(input, { id: 'PR_1', reviewId: 'R_1', message: 'Needs another look' });
    if (calls === 1) throw new ApiError('Repository rules prevent dismissal.', 403);
    pr = { ...pr, review: 'REVIEW_REQUIRED', reviewers: [{ ...pr.reviewers[0], state: 'DISMISSED', canRevoke: false }] };
    return pr;
  };
  const { page, origin, errors } = await browserFixture(t, { list });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Your approval options' }).click();
  assert.equal(await page.getByRole('button', { name: 'Your approval options' }).getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Your approval options');
  await page.getByRole('button', { name: 'Your approval options' }).click();
  await page.getByRole('button', { name: 'Revoke approval…', exact: true }).click();
  const submit = page.getByRole('button', { name: 'Revoke approval', exact: true });
  assert.equal(await submit.isDisabled(), true);
  await page.getByRole('textbox', { name: 'Reason', exact: true }).fill('Needs another look');
  await page.setViewportSize({ width: 420, height: 500 });
  await page.waitForFunction(() => {
    const rect = document.querySelector('#review-actions').getBoundingClientRect();
    return rect.left >= 7 && rect.right <= innerWidth - 7 && rect.top >= 7 && rect.bottom <= innerHeight - 7;
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: '/tmp/gh-pull-revoke-preview.png' });
  await submit.click();
  await page.getByRole('alert').filter({ hasText: 'Repository rules' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Reason', exact: true }).inputValue(), 'Needs another look');
  await submit.click();
  await page.locator('.reviewer-dismissed').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Your approval options' }).count(), 0);
  assert.equal(calls, 2); assert.deepEqual(errors, []);
});
