import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './browser-fixture.mjs';
import { ApiError } from '../github.js';

async function fixture(t, overrides = {}) {
  let pr = {
    id: 'fixture-pr', number: 1, title: 'Improve keyboard navigation',
    url: 'https://github.com/example/dashboard/pull/1', repo: 'example/dashboard',
    author: 'alice', status: 'OPEN', branch: 'feature/keyboard',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T01:00:00Z',
    additions: 520, deletions: 148, changedFiles: 8, commentCount: 12, review: 'NONE',
    checks: 'SUCCESS', reviewers: [], labels: [], canMerge: true,
    headOid: 'a'.repeat(40), mergeMethod: 'SQUASH', mergeMethods: ['MERGE', 'SQUASH', 'REBASE'],
    ...overrides,
  };
  let reject = false, hour = 1, hold, release;
  const list = async ({ query = '' } = {}) => {
    if (hold) await hold;
    const items = query.includes('does-not-exist') ? [] : [{ ...pr }];
    return { viewer: 'alice', total: items.length, items, pageInfo: { hasNextPage: false } };
  };
  list.mergeReadiness = async () => ({ items: [] });
  const update = fields => {
    if (reject) throw new ApiError('Fixture rejected this change', 403);
    pr = { ...pr, ...fields, updatedAt: `2026-01-01T${String(++hour).padStart(2, '0')}:00:00Z` };
    return { ...pr };
  };
  // Every action is implemented by this fixture. Nothing calls GitHub or gh CLI.
  const { page, origin, errors } = await browserFixture(t, {
    list,
    updateTitle: async ({ title }) => update({ title }),
    convertToDraft: async () => update({ status: 'DRAFT', canMerge: false }),
    markReadyForReview: async () => update({ status: 'OPEN', canMerge: true }),
    merge: async ({ mergeMethod }) => update({ status: 'MERGED', canMerge: false, mergeMethod }),
  });
  t.after(() => release?.());
  await page.addInitScript(() => {
    window.copiedText = null;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
      if (window.failClipboard) throw new Error('Clipboard denied');
      window.copiedText = text;
    } } });
  });
  const open = async () => {
    await page.goto(`${origin}/?state=all`);
    await page.locator('.pr-row').waitFor();
  };
  const unread = () => page.locator('.pr-row').evaluate(row => row.classList.contains('has-updates'));
  const waitRead = () => page.waitForFunction(() => !document.querySelector('.pr-row').classList.contains('has-updates'));
  const refresh = async () => {
    await page.click('#refresh');
    await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  };
  return {
    page, open, unread, waitRead, refresh, errors,
    reject: value => { reject = value; },
    laterUpdate: (fields = {}) => update(fields),
    holdRefresh: () => { hold = new Promise(resolve => { release = resolve; }); },
    releaseRefresh: () => { release(); hold = null; },
  };
}

test('conflicting PRs link to resolution in place of merge and update after refresh', async t => {
  const f = await fixture(t, { hasConflicts: true, canMerge: false });
  await f.open();
  const resolve = f.page.locator('.conflict-action');
  assert.equal(await resolve.textContent(), 'Resolve conflict');
  assert.equal(await resolve.getAttribute('href'), 'https://github.com/example/dashboard/pull/1/conflicts');
  assert.equal(await resolve.getAttribute('target'), '_blank');
  assert.equal(await f.page.locator('.merge-action').count(), 0);
  f.laterUpdate({ hasConflicts: false, canMerge: true });
  await f.refresh();
  assert.equal(await resolve.count(), 0);
  assert.equal(await f.page.locator('.merge-action').count(), 1);
  for (const changes of [{ status: 'MERGED' }, { status: 'DRAFT' }, { status: 'OPEN', author: 'bob' }]) {
    f.laterUpdate({ ...changes, hasConflicts: true, canMerge: false });
    await f.refresh();
    assert.equal(await resolve.count(), 0);
  }
});

test('review badges distinguish bypass permission from required reviews', async t => {
  for (const review of ['REVIEW_BYPASS_AVAILABLE', 'REVIEW_REQUIRED']) {
    const { page, open } = await fixture(t, { review, canMerge: false });
    await open();
    const badge = page.locator(`.badge.${review.toLowerCase()}`);
    assert.equal(await badge.textContent(), review === 'REVIEW_REQUIRED' ? 'Review required' : 'Review bypass available');
    if (review === 'REVIEW_BYPASS_AVAILABLE') assert.match(await badge.getAttribute('title'), /your account can bypass/);
    assert.equal(await page.locator('.merge-action').count(), 0);
  }
});

test('title, draft, ready and merge interactions preserve read state and retry behavior', async t => {
  const f = await fixture(t), { page } = f;
  await f.open();
  await page.click('.edit-title');
  await page.fill('.title-editor input', 'Cancelled edit');
  await page.press('.title-editor input', 'Escape');
  assert.equal(await page.locator('.pr-title').textContent(), 'Improve keyboard navigation');
  assert.equal(await f.unread(), true);
  await page.click('.edit-title');
  await page.fill('.title-editor input', 'Updated title');
  f.reject(true);
  await page.press('.title-editor input', 'Enter');
  await page.locator('.title-error').waitFor();
  assert.equal(await page.locator('.title-editor input').inputValue(), 'Updated title');
  assert.equal(await f.unread(), true);
  f.reject(false);
  await page.press('.title-editor input', 'Enter');
  await f.waitRead();
  assert.equal(await page.locator('.pr-title').textContent(), 'Updated title');
  await f.open();
  assert.equal(await f.unread(), false);
  for (const state of ['Draft', 'Open', 'Merged']) {
    f.laterUpdate(); await f.refresh();
    assert.equal(await f.unread(), true);
    const act = async () => {
      if (state === 'Merged') return page.click('.merge-action');
      await page.click('.lifecycle-action');
      await page.getByRole('button', { name: state === 'Draft' ? 'Convert to draft' : 'Mark ready for review', exact: true }).click();
    };
    f.reject(true); await act(); await page.locator('.draft-error').waitFor();
    assert.equal(await f.unread(), true);
    f.reject(false); await act(); await f.waitRead();
    assert.equal(await page.locator('.title-line > .badge').first().textContent(), state);
    await f.open(); assert.equal(await f.unread(), false);
  }
  assert.deepEqual(f.errors, []);
});

test('clipboard, filters, background refresh, icons and responsive metadata styling', async t => {
  const f = await fixture(t), { page } = f;
  await page.clock.install();
  await f.open();
  for (const [selector, text] of [['.copy-link', 'https://github.com/example/dashboard/pull/1'], ['.branch-copy', 'feature/keyboard']]) {
    await page.click(selector);
    await page.waitForFunction(expected => window.copiedText === expected, text);
    assert.match(await page.locator(selector).getAttribute('title'), /copied/);
    await page.clock.fastForward(2100);
    assert.equal(await page.locator(`${selector} svg`).count(), 1);
    await page.evaluate(() => { window.failClipboard = true; });
    await page.click(selector);
    await page.waitForFunction(s => document.querySelector(s).title.startsWith('Could not copy'), selector);
    await page.clock.fastForward(2100);
    assert.equal(await page.locator(`${selector} svg`).count(), 1);
    await page.evaluate(() => { window.failClipboard = false; });
  }
  for (const scope of ['authored', 'involved', 'review']) {
    await page.selectOption('#scope', scope);
    await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
    await page.selectOption('#scope', scope);
    assert.equal(await page.locator('#scope').inputValue(), scope);
  }
  await page.locator('.cm-content').fill('does-not-exist');
  await page.click('#query-submit');
  await page.waitForFunction(() => !document.querySelector('.pr-row'));
  await page.locator('.cm-content').fill(''); await page.click('#query-submit'); await page.locator('.pr-row').waitFor();
  f.holdRefresh(); await page.click('#refresh');
  assert.equal(await page.locator('#refresh').isDisabled(), true);
  assert.equal(await page.locator('.pr-row').count(), 1);
  f.releaseRefresh(); await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  assert.equal(await page.locator('.pr-files .file-count').textContent(), '8');
  assert.match(await page.locator('.pr-files').getAttribute('aria-label'), /8 files changed/);
  assert.match(await page.locator('.pr-files').getAttribute('href'), /\/files$/);
  assert.equal(await page.locator('.pr-files').getAttribute('target'), '_blank');
  assert.equal(await page.locator('.diff-counts + .comment-count').textContent(), '12');
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    assert.equal(await page.locator('.pr-ci .ci-indicator').count(), 1);
    assert.equal(await page.locator('.pr-reference .pr-number').count(), 1);
    assert.equal(await page.locator('.diff-counts').evaluate(el => getComputedStyle(el).flexDirection), 'column');
    for (const width of [1280, 375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  }
  assert.deepEqual(f.errors, []);
});


test('successful manual refresh clears a stale merge error', async t => {
  const f = await fixture(t);
  await f.open();
  f.reject(true);
  await f.page.locator('.merge-action').click();
  await f.page.getByText('Fixture rejected this change', { exact: true }).waitFor();
  await f.refresh();
  await f.page.getByText('Fixture rejected this change', { exact: true }).waitFor({ state: 'hidden' });
  assert.deepEqual(f.errors, []);
});

test('merge choices follow live repository options and preserve a valid selection across refresh', async t => {
  const f = await fixture(t);
  await f.open();
  const select = f.page.getByRole('combobox', { name: 'Merge method for example/dashboard #1' });
  assert.equal(await select.inputValue(), 'SQUASH');
  await select.focus();
  await select.press('ArrowDown');
  assert.equal(await select.inputValue(), 'REBASE');
  await select.press('Enter');
  await select.press('Escape');
  await f.page.mouse.move(0, 0);
  const border = await select.evaluate(e => {
    const style = getComputedStyle(e.closest('.merge-split'));
    return { width: style.borderTopWidth, shadow: style.boxShadow, outline: style.outlineStyle };
  });
  assert.deepEqual(border, { width: '1px', shadow: 'none', outline: 'none' }, 'selection keeps a single thin border even while focused');
  assert.equal(await f.page.locator('.merge-action').textContent(), 'Rebase and merge');
  await f.refresh();
  assert.equal(await select.inputValue(), 'REBASE');
  f.laterUpdate({ mergeMethods: ['MERGE', 'SQUASH'] });
  await f.refresh();
  assert.deepEqual(await select.locator('option').evaluateAll(options => options.map(o => o.value)), ['MERGE', 'SQUASH']);
  assert.equal(await select.inputValue(), 'SQUASH');
  await select.selectOption('MERGE');
  const request = f.page.waitForRequest(r => r.url().endsWith('/api/pulls/merge') && r.method() === 'PATCH');
  await f.page.locator('.merge-action').click();
  assert.equal((await request).postDataJSON().mergeMethod, 'MERGE');
  await f.page.waitForFunction(() => document.querySelector('.pr-row')?.textContent.includes('Merged'));
  assert.equal(await select.count(), 0);
  assert.deepEqual(f.errors, []);
});

test('single-method repositories need no selector and merge controls fit on mobile', async t => {
  const f = await fixture(t, { mergeMethods: ['SQUASH'] });
  await f.open();
  assert.equal(await f.page.locator('.merge-method').count(), 0);
  f.laterUpdate({ mergeMethods: ['MERGE', 'SQUASH', 'REBASE'] });
  await f.refresh();
  for (const colorScheme of ['light', 'dark']) {
    await f.page.emulateMedia({ colorScheme });
    await f.page.setViewportSize({ width: 375, height: 900 });
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const button = await f.page.locator('.merge-action').boundingBox();
    const arrow = await f.page.locator('.merge-method').boundingBox();
    assert.ok(Math.abs(button.x + button.width - arrow.x) <= 1, 'arrow joins the merge button');
    assert.ok(Math.abs(button.height - arrow.height) <= 1, 'both halves have matching heights');
    await f.page.screenshot({ path: `/tmp/gh-pull-merge-method-${colorScheme}.png`, fullPage: true });
  }
  assert.deepEqual(f.errors, []);
});

test('new-tab links release mouse focus but preserve keyboard focus on return', async t => {
  const f = await fixture(t);
  await f.open();
  for (const selector of ['.footer-links a[href*="issues/new?title"]', '.pr-title']) {
    const link = f.page.locator(selector).first();
    let popup = f.page.waitForEvent('popup');
    await link.click();
    await (await popup).close();
    await f.page.bringToFront();
    assert.equal(await link.evaluate(e => e === document.activeElement), false);
    await link.focus();
    popup = f.page.waitForEvent('popup');
    await link.press('Enter');
    await (await popup).close();
    await f.page.bringToFront();
    assert.equal(await link.evaluate(e => e === document.activeElement), true);
  }
  assert.deepEqual(f.errors, []);
});
