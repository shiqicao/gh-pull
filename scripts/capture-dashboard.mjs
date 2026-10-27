// Reproducible documentation screenshots using fictional PRs and local responses.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSavedViewsStore } from '../saved-views.js';

const now = Date.UTC(2026, 9, 14, 22, 30);
const repo = 'orbit-demo/web';
const make = (number, parent, title, minutes, extra = {}) => ({
  id: `demo-${number}`, number, title, repo, branchRepository: repo, defaultBranch: 'main',
  branch: `feature-${number}`, baseBranch: parent ? `feature-${parent}` : 'main',
  url: `https://github.com/${repo}/pull/${number}`, author: 'alex', status: 'OPEN',
  checks: 'SUCCESS', review: 'REVIEW_REQUIRED', reviewers: [{ name: 'maya', state: 'APPROVED' }], labels: [],
  additions: 84, deletions: 23, changedFiles: 4, commentCount: 3,
  updatedAt: new Date(now - minutes * 60_000).toISOString(), createdAt: '2026-10-10T12:00:00Z',
  ...extra,
});
const items = [
  make(248, null, 'Add the shared session API', 60, { review: 'APPROVED', canMerge: true, mergeMethod: 'SQUASH',
    headOid: 'a'.repeat(40), additions: 184, deletions: 32, changedFiles: 8,
    reviewers: [{ name: 'maya', state: 'APPROVED' }, { name: 'noah', state: 'APPROVED' }],
    closingIssueCount: 2, closingIssues: [{ number: 201, title: 'Unify session handling across clients', state: 'OPEN', repo, url: `https://github.com/${repo}/issues/201` }],
  }),
  make(251, 248, 'Build the sign-in flow on the session API', 35, { author: 'maya', additions: 312, deletions: 47,
    reviewers: [{ name: 'alex', state: 'REQUESTED' }, { name: 'zoe', state: 'APPROVED' }] }),
  make(252, 251, 'Keep form data when a session expires', 12, { checks: 'PENDING', checkCounts: { passed: 3, total: 8 },
    review: 'NONE', author: 'noah', additions: 96, deletions: 23, reviewers: [{ name: 'maya', state: 'REQUESTED' }] }),
  make(253, 251, 'Add keyboard navigation to the sign-in dialog', 40, { checks: 'FAILURE', review: 'CHANGES_REQUESTED',
    author: 'zoe', additions: 42, deletions: 18, reviewers: [{ name: 'alex', state: 'CHANGES_REQUESTED' }] }),
  make(254, 248, 'Record session events in the audit log', 90, { author: 'riley', additions: 118, deletions: 12,
    reviewers: [{ name: 'sam', state: 'REQUESTED' }] }),
  make(255, 248, 'Benchmark session handling in CI', 120, { review: 'APPROVED', additions: 203, deletions: 4,
    reviewers: [{ name: 'noah', state: 'APPROVED' }] }),
  make(246, null, 'Document local development and troubleshooting', 150, { author: 'sam', review: 'APPROVED',
    additions: 45, deletions: 9, changedFiles: 2, reviewers: [{ name: 'zoe', state: 'APPROVED' }] }),
  make(256, 240, 'Update preview deployment scripts', 180, { status: 'DRAFT', checks: 'PENDING', checkCounts: { passed: 2, total: 5 },
    review: 'NONE', additions: 60, deletions: 44, dependencyParent: { id: 'not-loaded', number: 240, status: 'OPEN' },
    reviewers: [{ name: 'riley', state: 'COMMENTED' }] }),
];
const list = async () => ({ viewer: 'alex', total: items.length, items, pageInfo: { hasNextPage: false } });
list.viewer = async () => 'alex';
// Fictional saved views in a throwaway store; never touch the real config directory.
const viewsDir = await mkdtemp(join(tmpdir(), 'gh-pull-capture-'));
const savedViews = createSavedViewsStore(join(viewsDir, 'views.json'), () => new Date(now).toISOString());
await savedViews.change('alex', { action: 'save', name: 'Involving me', query: 'is:open involves:@me sort:updated-desc', group: 'repo' });
await savedViews.change('alex', { action: 'save', name: 'To review', query: 'is:open review-requested:@me', group: 'repo' });
await savedViews.change('alex', { action: 'save', name: 'My drafts', query: 'is:open is:draft author:@me', group: 'status' });
const server = createApp({ localControl: { version: 'v1.0.0' }, list, savedViews });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1240 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await context.newPage();
  await page.clock.install({ time: now });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/updates') return route.fulfill({ json: { update: { version: 'v1.1.0', url: 'https://github.com/shiqicao/gh-pull/releases/tag/v1.1.0' } } });
    return route.continue();
  });
  await page.goto(origin);
  await page.locator('.dependency-dot').first().waitFor();
  // The reminder ships independently of the lanes; capture it when available.
  if (await page.locator('#update-notice').count()) await page.locator('#update-notice').waitFor();
  await page.getByRole('button', { name: 'To review' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => Number(document.querySelector('.dependency-connector').getAttribute('height')) === document.querySelector('.has-dependency-lanes').offsetHeight);
  assert.equal(await page.locator('.pr-row').count(), 8);
  assert.equal(await page.locator('.dependency-connector').getAttribute('width'), '92');
  assert.equal(await page.locator('.dependency-chip').innerText(), '↑ #240 · not loaded');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
  assert.doesNotMatch(await page.locator('#dashboard-controls').innerText(), /Could not/);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: new URL('../docs/marketplace-dashboard.png', import.meta.url).pathname });
  await copyFile(new URL('../docs/marketplace-dashboard.png', import.meta.url), new URL('../docs/demo.png', import.meta.url));
  console.log('Updated docs/marketplace-dashboard.png and docs/demo.png (3200 × 2480).');
} finally {
  await browser.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await rm(viewsDir, { recursive: true, force: true });
}
