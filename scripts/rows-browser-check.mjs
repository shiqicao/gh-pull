import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './browser-fixture.mjs';

async function fixture(t) {
  let items = [1, 2, 3].map(number => ({
    id: `pr-${number}`, number, title: `Pull ${number}`, repo: 'example/dashboard',
    url: `https://github.com/example/dashboard/pull/${number}`, author: 'alice', status: 'OPEN',
    checks: 'PENDING', checkCounts: { passed: 1, total: 8 }, review: 'NONE', reviewers: [], labels: [],
    branch: `feature/${number}`, defaultBranch: 'main', baseBranch: number === 2 ? 'feature/1' : 'main',
    branchRepository: 'example/dashboard', additions: 12, deletions: 3, changedFiles: 2, commentCount: 0,
    closingIssueCount: 1, closingIssues: [{ number: 10, title: 'Linked issue', state: 'OPEN', repo: 'example/dashboard', url: 'https://github.com/example/dashboard/issues/10' }],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T01:00:00Z',
  }));
  const list = async () => ({ viewer: 'alice', total: items.length, items, pageInfo: { hasNextPage: false } });
  list.status = async () => ({ items });
  const f = await browserFixture(t, { list });
  await f.page.route(/\/api\/pulls\?/, async route => route.fulfill({ json: await list() }));
  await f.page.clock.install();
  await f.page.goto(f.origin);
  await f.page.locator('.pr-row').first().waitFor();
  const idle = () => f.page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  await idle();
  return { ...f, idle,
    update: (id, values) => { items = items.map(pr => pr.id === id ? { ...pr, ...values } : pr); },
    remove: id => { items = items.filter(pr => pr.id !== id); },
    refresh: async () => { await f.page.click('#refresh'); await idle(); },
  };
}

test('rows, focus and dependency canvas survive refresh and changed rows update in place', async t => {
  const f = await fixture(t), { page } = f;
  await page.evaluate(() => {
    window.savedRow = document.querySelector('[data-pr-id="pr-1"]');
    window.savedCanvas = document.querySelector('.dependency-connector');
    window.savedControl = window.savedRow.querySelector('.branch-copy');
    window.savedControl.focus();
  });
  await page.clock.fastForward(15000); await f.idle();
  assert.equal(await page.evaluate(() => document.activeElement === window.savedControl && window.savedRow.isConnected && window.savedCanvas.isConnected), true);
  f.update('pr-3', { checks: 'SUCCESS', updatedAt: '2026-02-01T00:00:00Z' });
  await page.clock.fastForward(15000); await f.idle();
  await page.waitForFunction(() => document.querySelector('[data-pr-id="pr-3"]').textContent.includes('Checks passed'));
  assert.equal(await page.evaluate(() => document.activeElement === window.savedControl && document.querySelector('[data-pr-id="pr-1"]') === window.savedRow), true);
  assert.equal(await page.locator('.pr-row').first().getAttribute('data-pr-id'), 'pr-3');
  f.remove('pr-2'); await f.refresh();
  assert.equal(await page.locator('[data-pr-id="pr-2"]').count(), 0);
  assert.equal(await page.locator('.dependency-connector').count(), 0);
  assert.deepEqual(f.errors, []);
});

test('background updates refresh other rows without replacing an active editor or popover', async t => {
  const f = await fixture(t), { page } = f;
  await page.locator('[data-pr-id="pr-1"] .edit-title').click();
  await page.locator('.title-editor input').fill('Unsaved draft');
  await page.evaluate(() => {
    window.editor = document.querySelector('.title-editor input');
    window.editor.setSelectionRange(2, 6);
  });
  f.update('pr-1', { title: 'Server title' });
  f.update('pr-3', { checks: 'SUCCESS' });
  await page.clock.fastForward(15000); await f.idle();
  await page.waitForFunction(() => document.querySelector('[data-pr-id="pr-3"]').textContent.includes('Checks passed'));
  assert.deepEqual(await page.evaluate(() => [document.activeElement === window.editor, window.editor.value, window.editor.selectionStart, window.editor.selectionEnd]), [true, 'Unsaved draft', 2, 6]);
  await page.locator('.title-editor input').press('Escape');
  await page.locator('[data-pr-id="pr-1"] .issue-count').click();
  f.update('pr-3', { title: 'Updated while popover open' });
  await page.clock.fastForward(15000); await f.idle();
  await page.waitForFunction(() => document.querySelector('[data-pr-id="pr-3"] .pr-title').textContent === 'Updated while popover open');
  assert.equal(await page.locator('#closing-issues').evaluate(panel => panel.matches(':popover-open')), true);
  await page.keyboard.press('Escape');
  await f.refresh();
  assert.equal(await page.locator('[data-pr-id="pr-1"] .pr-title').textContent(), 'Server title');
  assert.deepEqual(f.errors, []);
});

test('missing protected rows retain their position and refetch when editing ends', async t => {
  const f = await fixture(t), { page } = f;
  f.update('pr-2', { baseBranch: 'main' }); await f.refresh();
  await page.locator('[data-pr-id="pr-1"] .edit-title').click();
  f.remove('pr-1');
  await page.clock.fastForward(30000); await f.idle();
  assert.equal(await page.locator('.pr-row').first().getAttribute('data-pr-id'), 'pr-1');
  assert.equal(await page.locator('#summary').textContent(), '3 loaded · 3 total');
  await page.locator('.title-editor input').press('Escape');
  await page.clock.fastForward(1000); await f.idle();
  assert.equal(await page.locator('.pr-row[data-pr-id="pr-1"]').count(), 0);
  assert.equal(await page.locator('#summary').textContent(), '2 loaded · 2 total');
});

test('protected rows gain and lose dependency gutters without replacing their editor', async t => {
  const f = await fixture(t), { page } = f;
  f.update('pr-2', { baseBranch: 'main' }); await f.refresh();
  await page.locator('[data-pr-id="pr-1"] .edit-title').click();
  await page.evaluate(() => { window.editor = document.querySelector('.title-editor input'); });
  f.update('pr-2', { baseBranch: 'feature/1' });
  await page.clock.fastForward(30000); await f.idle();
  assert.equal(await page.locator('.dependency-node').filter({has: page.locator('[data-pr-id="pr-1"]')}).locator('.dependency-gutter').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement === window.editor), true);
  f.update('pr-2', { baseBranch: 'main' });
  await page.clock.fastForward(30000); await f.idle();
  assert.equal(await page.locator('.dependency-gutter').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement === window.editor), true);
});


test('fallback DOM moves preserve focus and selection without moveBefore', async t => {
  const f = await fixture(t), { page } = f;
  await page.evaluate(() => { Element.prototype.moveBefore = undefined; });
  await page.locator('[data-pr-id="pr-3"] .edit-title').click();
  await page.locator('.title-editor input').fill('Keep selection');
  await page.evaluate(() => {
    window.editor = document.querySelector('.title-editor input');
    window.editor.setSelectionRange(2, 7);
  });
  f.update('pr-1', { updatedAt: '2025-01-01T00:00:00Z' });
  f.update('pr-2', { updatedAt: '2025-01-01T00:00:00Z' });
  await page.clock.fastForward(15000); await f.idle();
  assert.equal(await page.evaluate(() => document.activeElement === window.editor), true);
  // Re-grouping moves retained entries between lists on older browsers too.
  await page.selectOption('#group', 'author');
  assert.equal(await page.evaluate(() => window.editor.isConnected), true);
  assert.deepEqual(await page.evaluate(() => [window.editor.value, window.editor.selectionStart, window.editor.selectionEnd]), ['Keep selection', 2, 7]);
});


test('a focused control and active editor survive changes to their own PR', async t => {
  const f = await fixture(t), { page } = f;
  await page.locator('[data-pr-id="pr-1"] .branch-copy').focus();
  await page.evaluate(() => { window.control = document.activeElement; });
  f.update('pr-1', { checks: 'SUCCESS', commentCount: 9 });
  await page.clock.fastForward(15000); await f.idle();
  assert.equal(await page.evaluate(() => document.activeElement === window.control), true);
  assert.match(await page.locator('.pr-row[data-pr-id="pr-1"]').textContent(), /Checks passed/);
  await page.locator('[data-pr-id="pr-1"] .edit-title').click();
  await page.locator('.title-editor input').fill('Unsaved local title');
  await page.evaluate(() => { window.editor = document.activeElement; window.editor.setSelectionRange(3, 9); });
  f.update('pr-1', { title: 'Upstream title changed', checks: 'FAILURE', baseBranch: 'external-base' });
  await page.clock.fastForward(15000); await f.idle();
  assert.equal(await page.locator('[data-pr-id="pr-1"] .pr-title').textContent(), 'Upstream title changed');
  assert.match(await page.locator('[data-pr-id="pr-1"] .dependency-chip').textContent(), /base not loaded/);
  assert.deepEqual(await page.evaluate(() => [document.activeElement === window.editor, window.editor.value, window.editor.selectionStart, window.editor.selectionEnd]), [true, 'Unsaved local title', 3, 9]);
  assert.deepEqual(f.errors, []);
});

test('open issue popover and its focused link survive updates to the owning PR', async t => {
  const f = await fixture(t), { page } = f;
  await page.locator('[data-pr-id="pr-1"] .issue-count').click();
  await page.locator('.issue-link').focus();
  await page.evaluate(() => { window.link = document.activeElement; window.trigger = document.querySelector('[data-pr-id="pr-1"] .issue-count'); });
  f.update('pr-1', { checks: 'SUCCESS', closingIssues: [{ number: 10, title: 'Changed linked issue', state: 'CLOSED', repo: 'example/dashboard', url: 'https://github.com/example/dashboard/issues/10' }] });
  await page.clock.fastForward(15000); await f.idle();
  assert.equal(await page.locator('#closing-issues').evaluate(panel => panel.matches(':popover-open')), true);
  assert.equal(await page.evaluate(() => document.activeElement === window.link && window.trigger === document.querySelector('[data-pr-id="pr-1"] .issue-count')), true);
  assert.equal(await page.locator('.issue-title').textContent(), 'Changed linked issue');
  assert.match(await page.locator('.issue-detail').textContent(), /Closed/);
  assert.deepEqual(f.errors, []);
});

test('retained clipboard buttons copy the latest value once and restore their icon', async t => {
  const f = await fixture(t), { page } = f;
  await page.evaluate(() => {
    window.copies = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copies.push(text); } } });
  });
  const button = page.locator('[data-pr-id="pr-1"] .branch-copy');
  await button.click();
  await page.waitForFunction(() => document.querySelector('[data-pr-id="pr-1"] .copy-symbol').textContent === '✓' || window.copies.length === 1);
  f.update('pr-1', { branch: 'feature/new-name', commentCount: 7 });
  await f.refresh();
  await f.refresh();
  await button.click();
  assert.deepEqual(await page.evaluate(() => window.copies), ['feature/1', 'feature/new-name']);
  await page.clock.fastForward(2000);
  assert.equal(await button.getAttribute('data-tooltip'), 'Copy branch name: feature/new-name');
  assert.equal(await button.locator('.copy-symbol svg').count(), 1);
  assert.deepEqual(f.errors, []);
});

test('typing a title updates its row without rendering the dashboard', async t => {
  const f = await fixture(t), { page } = f;
  await page.locator('[data-pr-id="pr-1"] .edit-title').click();
  await page.evaluate(() => {
    window.dashboardRenders = 0;
    window.observer = new MutationObserver(records => { window.dashboardRenders += records.filter(r => r.attributeName === 'aria-busy').length; });
    window.observer.observe(document.querySelector('#results'), { attributes: true });
  });
  await page.locator('.title-editor input').pressSequentially(' edited');
  assert.equal(await page.locator('.title-editor button[type="submit"]').isEnabled(), true);
  assert.equal(await page.evaluate(() => window.dashboardRenders), 0);
  await page.locator('.title-editor input').fill('');
  assert.equal(await page.locator('.title-editor button[type="submit"]').isEnabled(), false);
  assert.deepEqual(f.errors, []);
});
