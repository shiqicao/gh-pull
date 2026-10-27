import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './browser-fixture.mjs';
import { ApiError } from '../github.js';

test('manage own reviewers: lazy search, errors, re-request, team, remove, dismissal', async t => {
  let pr = { id: 'P1', number: 1, title: 'Make reviewer management easier', repo: 'example/dashboard', author: 'alice', status: 'OPEN', checks: 'SUCCESS', review: 'APPROVED', labels: [], additions: 12, deletions: 3,
    url: 'https://github.com/example/dashboard/pull/1', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z', reviewers: [{ name: 'bob', state: 'APPROVED' }, { name: 'carol', state: 'REQUESTED' }] };
  const list = async () => ({ viewer: 'alice', items: [pr, { ...pr, id: 'P2', author: 'other' }, { ...pr, id: 'P3', status: 'DRAFT' }], total: 3, pageInfo: { hasNextPage: false } });
  let searches = 0, calls = 0;
  list.reviewerSuggestions = async (id, q) => { searches++; return { reviewers: q ? [] : [{ name: 'dana', displayName: 'Dana', kind: 'user' }], limited: false }; };
  list.changeReviewer = async input => {
    calls++;
    if (calls === 1) throw new ApiError('GitHub denied reviewer access.', 403);
    pr = { ...pr, updatedAt: new Date().toISOString(), reviewers: input.action === 'remove' ? pr.reviewers.filter(r => r.name !== input.name) : [...pr.reviewers.filter(r => r.name !== input.name), { name: input.name, state: 'REQUESTED' }] };
    return pr;
  };
  const { page, origin, errors } = await browserFixture(t, { list });
  await page.goto(origin);
  const trigger = page.locator('[data-pr-id=P1]').getByRole('button', { name: /Manage reviewers/ });
  await trigger.waitFor(); assert.equal(searches, 0);
  assert.equal((await trigger.innerText()).trim(), '');
  const offsets = await page.locator('.reviewer-manage').evaluateAll(buttons => buttons.map(button => {
    const row = button.closest('.pr-row').getBoundingClientRect(), rect = button.getBoundingClientRect();
    return [row.right - rect.right, rect.top - row.top];
  }));
  assert.deepEqual(offsets[0], offsets[1]);
  assert.equal(await page.locator('[data-pr-id=P2]').getByRole('button', { name: /Manage reviewers/ }).count(), 0);
  assert.equal(await page.locator('[data-pr-id=P3]').getByRole('button', { name: /Manage reviewers/ }).isDisabled(), true);
  await trigger.click();
  const panel = page.getByRole('dialog', { name: 'Manage reviewers', exact: true });
  await panel.getByRole('textbox').click();
  await panel.getByRole('heading', { name: 'Contributors and suggestions' }).waitFor();
  await panel.getByRole('button', { name: 'Request review from dana', exact: true }).waitFor();
  const rowHue = await page.locator('[data-pr-id=P1] .reviewer .author').first().evaluate(el => el.style.getPropertyValue('--author-hue'));
  const popupHue = await panel.locator('.reviewer-choice-name .author').first().evaluate(el => el.style.getPropertyValue('--author-hue'));
  assert.equal(popupHue, rowHue); assert.notEqual(popupHue, '');
  await panel.getByRole('button', { name: 'Re-request review from bob' }).click();
  assert.equal(calls, 0);
  await panel.getByRole('button', { name: 'Undo change for bob' }).waitFor();
  await panel.getByRole('button', { name: /Apply changes/ }).click();
  await panel.getByRole('alert').filter({ hasText: 'denied' }).waitFor();
  await panel.getByRole('button', { name: /Apply changes/ }).click();
  await panel.getByRole('button', { name: 'Remove request for bob' }).waitFor();
  await panel.getByRole('button', { name: 'Remove request for carol' }).click();
  assert.equal(calls, 2);
  await panel.getByRole('button', { name: /Apply changes/ }).click();
  await page.waitForFunction(() => !document.querySelector('#manage-reviewers button[aria-label="Undo change for carol"]'));
  await panel.getByRole('textbox').fill('example/core');
  await panel.getByRole('button', { name: 'Request review from example/core' }).click();
  assert.equal(calls, 3);
  await panel.getByRole('button', { name: /Apply changes/ }).click();
  await panel.getByRole('button', { name: 'Remove request for example/core' }).waitFor();
  assert.equal(calls, 4);
  assert.notEqual(await panel.locator('.reviewer-choice-name .author').filter({ hasText: 'example/core' }).evaluate(el => el.style.getPropertyValue('--author-hue')), '');
  await page.setViewportSize({ width: 375, height: 650 });
  await page.waitForFunction(() => { const r = document.querySelector('#manage-reviewers').getBoundingClientRect(); return r.left >= 7 && r.right <= innerWidth - 7 && r.top >= 7 && r.bottom <= innerHeight - 7; });
  if (process.env.GH_PULL_SCREENSHOTS) await page.screenshot({ path: '/tmp/gh-pull-reviewer-manager.png' });
  await panel.getByRole('button', { name: 'Remove request for bob' }).click();
  await panel.getByRole('button', { name: 'Undo change for bob' }).click();
  assert.equal(await panel.getByRole('button', { name: /Apply changes/ }).isDisabled(), true);
  await panel.getByRole('button', { name: 'Remove request for bob' }).click();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  await trigger.click();
  assert.equal(await panel.getByRole('button', { name: /Apply changes/ }).isDisabled(), true);
  assert.equal(calls, 4); await panel.waitFor(); await trigger.click(); await panel.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
});

test('late reviewer searches cannot overwrite a newer query or reopen dismissed popover', async t => {
  const pr = { id: 'P1', number: 1, title: 'Search race', repo: 'example/dashboard', author: 'alice', status: 'OPEN', checks: 'NONE', review: 'NONE', labels: [], reviewers: [], additions: 0, deletions: 0, createdAt: '2026-10-20', updatedAt: '2026-10-20' };
  const list = async () => ({ viewer: 'alice', items: [pr], total: 1, pageInfo: { hasNextPage: false } });
  list.reviewerSuggestions = async () => ({ reviewers: [], limited: false });
  const { page, origin } = await browserFixture(t, { list });
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  await page.route('**/api/pulls/reviewers?*', async route => {
    if (new URL(route.request().url()).searchParams.get('q') === 'slow') {
      started(); await new Promise(resolve => { release = resolve; });
      await route.fulfill({ json: { reviewers: [{ name: 'stale', kind: 'user' }] } }).catch(() => {});
    } else await route.fulfill({ json: { reviewers: [{ name: 'fresh', kind: 'user' }] } });
  });
  await page.goto(origin); await page.getByRole('button', { name: /Manage reviewers/ }).click();
  const panel = page.getByRole('dialog', { name: 'Manage reviewers', exact: true });
  await panel.getByRole('textbox').fill('slow'); await waiting;
  await panel.getByRole('textbox').fill('new');
  await panel.getByRole('button', { name: 'Request review from fresh' }).waitFor();
  release();
  assert.equal(await panel.getByRole('button', { name: 'Request review from stale' }).count(), 0);
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' });
});


test('reviewer confirmation retains only failed and unapplied selections after partial success', async t => {
  let pr = { id: 'P1', number: 1, title: 'Confirm reviewers', repo: 'example/dashboard', author: 'alice', status: 'OPEN', checks: 'NONE', review: 'NONE', labels: [], reviewers: [], additions: 0, deletions: 0, createdAt: '2026-10-20', updatedAt: '2026-10-20' };
  const list = async () => ({ viewer: 'alice', items: [pr], total: 1, pageInfo: { hasNextPage: false } });
  list.reviewerSuggestions = async () => ({ reviewers: ['bob', 'carol', 'dana'].map(name => ({ name, kind: 'user' })), limited: false });
  const calls = [];
  list.changeReviewer = async input => {
    calls.push(input.name);
    if (calls.length === 2) throw new ApiError('Try again', 403);
    pr = { ...pr, reviewers: [...pr.reviewers, { name: input.name, state: 'REQUESTED' }] };
    return pr;
  };
  const { page, origin, errors } = await browserFixture(t, { list });
  await page.goto(origin); await page.getByRole('button', { name: /Manage reviewers/ }).click();
  const panel = page.getByRole('dialog', { name: 'Manage reviewers', exact: true });
  for (const name of ['bob', 'carol', 'dana']) await panel.getByRole('button', { name: `Request review from ${name}`, exact: true }).click();
  assert.deepEqual(calls, []);
  await panel.getByRole('textbox').fill('someone');
  await panel.getByRole('button', { name: 'Undo change for bob' }).waitFor();
  await panel.getByRole('button', { name: 'Apply changes (3)' }).click();
  await panel.getByRole('alert').filter({ hasText: 'Try again' }).waitFor();
  assert.deepEqual(calls, ['bob', 'carol']);
  await panel.getByRole('button', { name: 'Remove request for bob' }).waitFor();
  await panel.getByRole('button', { name: 'Apply changes (2)' }).click();
  await panel.getByRole('button', { name: 'Remove request for dana' }).waitFor();
  assert.deepEqual(calls, ['bob', 'carol', 'carol', 'dana']);
  assert.equal(await panel.getByRole('button', { name: /Apply changes/ }).isDisabled(), true);
  assert.deepEqual(errors, []);
});
