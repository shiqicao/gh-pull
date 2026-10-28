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
  assert.equal(await trigger.getAttribute('aria-describedby'), 'row-tooltip');
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

test('title and reviewer hover tooltips share a half-second delay', async t => {
  const title = 'A long PR title that should use the same styled tooltip as reviewers';
  const pr = { id: 'delay', number: 2, title, url: 'https://github.com/example/demo/pull/2', repo: 'example/demo', author: 'bob', status: 'OPEN', checks: 'NONE', review: 'NONE', labels: [], additions: 0, deletions: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01', reviewers: [{ name: 'alice', state: 'REQUESTED' }] };
  const { page, origin } = await browserFixture(t, { list: async () => ({ viewer: 'bob', items: [pr], total: 1, pageInfo: { hasNextPage: false } }) });
  await page.clock.install();
  await page.goto(origin); await page.locator('.pr-title').waitFor();
  await page.clock.pauseAt(new Date());
  for (const [selector, text] of [['.reviewer-avatar', 'alice'], ['.pr-title', title]]) {
    await page.locator(selector).hover();
    await page.clock.runFor(450);
    assert.equal(await page.getByRole('tooltip').isVisible(), false);
    await page.clock.runFor(100);
    await page.getByRole('tooltip').waitFor();
    assert.ok((await page.getByRole('tooltip').textContent()).includes(text));
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
  }
  assert.equal(await page.locator('.pr-title').getAttribute('title'), null);
});

test('plain hints share styled tooltips, update dynamically, and dismiss when removed', async t => {
  const pr = { id: 'hints', number: 3, title: 'Shared hints', url: 'https://github.com/example/demo/pull/3', repo: 'example/demo', author: 'bob', status: 'OPEN', checks: 'SUCCESS', review: 'NONE', branch: 'feature/long-branch', labels: [], additions: 20, deletions: 4, createdAt: '2026-01-01', updatedAt: '2026-01-01', reviewers: [] };
  const { page, origin, errors } = await browserFixture(t, { list: async () => ({ viewer: 'bob', items: [pr], total: 1, pageInfo: { hasNextPage: false } }) });
  await page.goto(origin);
  const tip = page.getByRole('tooltip');
  for (const selector of ['.ci-indicator', '.diff-counts', '.updated-time', '.branch-copy', '.copy-link', '#refresh']) {
    const target = page.locator(selector).first();
    await target.hover(); await tip.waitFor();
    assert.equal(await tip.textContent(), await target.getAttribute('data-tooltip'));
    assert.equal(await target.getAttribute('title'), null);
    await page.keyboard.press('Escape');
  }
  await page.locator('.branch-copy').focus(); await tip.waitFor();
  await page.locator('.branch-copy').evaluate(el => { el.dataset.tooltip = 'Changed hint'; });
  await page.waitForFunction(() => document.querySelector('#row-tooltip').textContent === 'Changed hint');
  await page.locator('.branch-copy').evaluate(el => el.remove());
  await tip.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[title]').count(), 0);
  assert.deepEqual(errors, []);
});
