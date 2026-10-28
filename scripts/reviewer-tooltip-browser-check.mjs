import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './browser-fixture.mjs';

test('reviewer tooltips support hover, focus, Escape and leave approval actions usable', async t => {
  const pr = { id: 'tooltip', number: 1, title: 'Reviewer tooltip', repo: 'example/demo', author: 'bob', status: 'OPEN', checks: 'SUCCESS', review: 'APPROVED', labels: [], additions: 1, deletions: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01', reviewers: [
    { name: 'alice', state: 'APPROVED', canRevoke: true, reviewId: 'review', reviewUrl: 'https://github.com/example/demo/pull/1#pullrequestreview-1' },
    { name: 'example/platform-team', kind: 'team', state: 'REQUESTED' },
  ] };
  const list = async () => ({ viewer: 'alice', items: [pr], total: 1, pageInfo: { hasNextPage: false } });
  const { page, origin, errors } = await browserFixture(t, { list });
  await page.goto(origin);
  const trigger = page.getByRole('button', { name: 'Your approval options' });
  const tooltip = page.getByRole('tooltip');
  await trigger.hover(); await tooltip.waitFor();
  assert.match(await tooltip.textContent(), /alice.*Approved.*Click for approval options/);
  assert.equal(await trigger.getAttribute('aria-describedby'), 'reviewer-tooltip');
  await tooltip.hover(); assert.equal(await tooltip.isVisible(), true);
  await page.keyboard.press('Escape'); await tooltip.waitFor({ state: 'hidden' });
  assert.equal(await trigger.getAttribute('aria-describedby'), null);
  await trigger.focus(); await tooltip.waitFor();
  await trigger.click(); await tooltip.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Revoke approval…' }).waitFor();
  await page.keyboard.press('Escape');
  const team = page.locator('.reviewer-avatar[aria-label="example/platform-team"]');
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await team.focus(); await tooltip.waitFor();
    assert.match(await tooltip.textContent(), /example\/platform-team.*Awaiting review/);
    const box = await tooltip.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width);
    await page.keyboard.press('Escape'); await tooltip.waitFor({ state: 'hidden' });
    await team.blur();
  }
  assert.deepEqual(errors, []);
});
