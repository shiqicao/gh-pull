import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { browserFixture } from './browser-fixture.mjs';

const issues = [
  { title: 'Fix sign-in redirect when returning from an expired session', number: 123, repo: 'example/dashboard', state: 'OPEN', url: 'https://github.com/example/dashboard/issues/123' },
  { title: 'Handle expired sessions without losing unsaved changes', number: 456, repo: 'example/auth', state: 'CLOSED', url: 'https://github.com/example/auth/issues/456' },
];
const base = { id: 'one', number: 1, title: 'Improve sign-in and session recovery', url: 'https://github.com/example/dashboard/pull/1',
  author: 'alice', repo: 'example/dashboard', status: 'OPEN', checks: 'SUCCESS', review: 'NONE', reviewers: [], labels: [],
  branch: 'fix/session-recovery', additions: 520, deletions: 148, commentCount: 3, changedFiles: 8,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T01:00:00Z',
  closingIssueCount: 2, closingIssues: issues,
};
async function fixture(t) {
  const f = await browserFixture(t, { list: async () => ({ viewer: 'alice', total: 3,
    items: [base, { ...base, id: 'two', number: 2, title: 'Refactor the request cache', closingIssueCount: 0, closingIssues: [] },
      { ...base, id: 'three', number: 3, title: 'Resolve tracked follow-ups', closingIssueCount: 25, closingIssuesTruncated: true,
        closingIssues: Array.from({ length: 20 }, (_, i) => ({ ...issues[i % 2], number: i + 1 })) }],
    pageInfo: { hasNextPage: false },
  }) });
  await f.page.goto(f.origin); await f.page.locator('.pr-row').first().waitFor();
  return f;
}

test('issue counts open full titles and states, hide empty lists, and support keyboard/outside dismissal', async t => {
  const { page, errors } = await fixture(t);
  const trigger = page.locator('.issue-count').first(), panel = page.locator('#closing-issues');
  assert.equal(await page.locator('.issue-count').count(), 2);
  assert.equal(await trigger.textContent(), '2');
  assert.equal(await trigger.getAttribute('title'), 'Closes 2 issues');
  assert.equal(await trigger.evaluate(el => Boolean(el.closest('.pr-extras'))), true);
  assert.equal(await page.locator('.pr-row').first().locator('.comment-count').evaluate(el => getComputedStyle(el).gridColumnStart), '7');
  await trigger.focus(); await page.keyboard.press('Enter'); await panel.waitFor();
  await page.waitForFunction(() => document.querySelector('.issue-count').getAttribute('aria-expanded') === 'true');
  assert.deepEqual(await panel.locator('.issue-title').allTextContents(), issues.map(issue => issue.title));
  assert.match(await panel.innerText(), /Closed · example\/auth #456/);
  assert.equal(await panel.locator('.issue-link').first().getAttribute('href'), issues[0].url);
  assert.equal(await panel.locator('.issue-link').first().getAttribute('target'), '_blank');
  await page.emulateMedia({ colorScheme: 'dark' });
  await mkdir('/tmp/gh-pull-issues', { recursive: true });
  await page.screenshot({ path: '/tmp/gh-pull-issues/two-issues-dark.png' });
  await page.keyboard.press('Tab');
  assert.equal(await panel.locator('.issue-link').first().evaluate(link => link === document.activeElement), true);
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate(button => button === document.activeElement), true);
  await trigger.click(); await panel.waitFor();
  await page.locator('h1').click(); await panel.waitFor({ state: 'hidden' });
  await page.locator('.issue-count').last().click(); await panel.waitFor();
  assert.equal(await panel.locator('.issue-link').count(), 20);
  assert.equal(await panel.locator('.issue-more').getAttribute('href'), base.url);
  assert.deepEqual(errors, []);
});

test('issue popover fits mobile/desktop in both themes and remains open during background polling', async t => {
  const { page, errors } = await fixture(t);
  await page.clock.install();
  await mkdir('/tmp/gh-pull-issues', { recursive: true });
  for (const colorScheme of ['light', 'dark']) for (const width of [1280, 375, 320]) {
    await page.emulateMedia({ colorScheme }); await page.setViewportSize({ width, height: 800 });
    await page.locator('.issue-count').last().click();
    const panel = page.locator('#closing-issues'); await panel.waitFor();
    await page.waitForFunction(() => {
      const box = document.querySelector('#closing-issues').getBoundingClientRect();
      return box.x >= 0 && box.right <= innerWidth && box.y >= 0 && box.bottom <= innerHeight;
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.clock.fastForward(31_000);
    assert.equal(await panel.isVisible(), true);
    const audit = await new AxeBuilder({ page }).include('#closing-issues').analyze();
    assert.deepEqual(audit.violations, []);
    await page.screenshot({ path: `/tmp/gh-pull-issues/${colorScheme}-${width}.png` });
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
});

test('issue titles render as text and malformed links cannot execute scripts', async t => {
  const { page, origin } = await browserFixture(t, { list: async () => ({ viewer: 'alice', total: 1,
    items: [{ ...base, closingIssueCount: 1, closingIssues: [{ ...issues[0], title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' }] }],
    pageInfo: { hasNextPage: false },
  }) });
  await page.goto(origin); await page.locator('.issue-count').click();
  assert.equal(await page.locator('.issue-title').textContent(), '<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('.issue-title img').count(), 0);
  assert.equal(await page.locator('.issue-link').getAttribute('href'), null);
});

test('issue popovers open at their final position before the first paint, including different rows and sizes', async t => {
  const { page } = await fixture(t);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    for (const index of [0, 1, 0]) {
      const button = page.locator('.issue-count').nth(index);
      await button.scrollIntoViewIfNeeded();
      const positions = await button.evaluate(async trigger => {
        const panel = document.querySelector('#closing-issues');
        const box = () => {
          const rect = panel.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        trigger.click();
        const initial = box();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const settled = box();
        return { initial, settled, visible: getComputedStyle(panel).visibility, open: panel.matches(':popover-open') };
      });
      assert.equal(positions.open, true);
      assert.equal(positions.visible, 'visible');
      assert.ok(positions.initial.width > 0);
      assert.deepEqual(positions.initial, positions.settled, 'The first visible position must already be final');
      await page.keyboard.press('Escape');
    }
  }
});
