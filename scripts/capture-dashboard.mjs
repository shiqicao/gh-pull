// Reproducible documentation screenshots using fictional PRs and local responses.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import { copyFile, mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSavedViewsStore } from '../saved-views.js';

const recordTour = process.argv.includes('--video');
const readmeOnly = process.argv.includes('--readme');
const now = Date.UTC(2026, 9, 27, 22, 30);
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
  make(248, null, 'Add the shared session API', 60, { review: 'APPROVED', canMerge: true, mergeMethod: 'SQUASH', mergeMethods: ['SQUASH', 'MERGE', 'REBASE'],
    headOid: 'a'.repeat(40), additions: 184, deletions: 32, changedFiles: 8,
    reviewers: [{ name: 'maya', state: 'APPROVED' }, { name: 'noah', state: 'APPROVED' }],
    closingIssueCount: 2, closingIssues: [{ number: 201, title: 'Unify session handling across clients', state: 'OPEN', repo, url: `https://github.com/${repo}/issues/201` }],
  }),
  make(251, 248, 'Build the sign-in flow on the session API', 35, { author: 'maya', additions: 312, deletions: 47,
    reviewers: [{ name: 'alex', state: 'REQUESTED' }, { name: 'zoe', state: 'APPROVED' }] }),
  make(252, 251, 'Keep form data when a session expires', 12, { checks: 'PENDING', checkCounts: { passed: 3, total: 8 },
    review: 'NONE', author: 'noah', additions: 96, deletions: 23, reviewers: [{ name: 'maya', state: 'REQUESTED' }] }),
  make(253, 251, 'Add keyboard navigation to the sign-in dialog', 40, { checks: 'FAILURE', review: 'CHANGES_REQUESTED',
    failedChecks: { total: 2, truncated: false, items: [
      { name: 'Keyboard navigation tests', url: `https://github.com/${repo}/actions/runs/100/jobs/101` },
      { name: 'Accessibility checks', url: `https://github.com/${repo}/actions/runs/100/jobs/102` },
    ] },
    author: 'zoe', additions: 42, deletions: 18, reviewers: [{ name: 'alex', state: 'CHANGES_REQUESTED' }] }),
  make(254, 248, 'Record session events in the audit log', 90, { author: 'riley', additions: 118, deletions: 12,
    reviewers: [{ name: 'sam', state: 'REQUESTED' }] }),
  make(255, 248, 'Benchmark session handling in CI', 1440, { review: 'APPROVED', additions: 203, deletions: 4,
    reviewers: [{ name: 'noah', state: 'APPROVED' }] }),
  make(246, null, 'Document local development and troubleshooting', 10080, { author: 'sam', review: 'APPROVED',
    additions: 45, deletions: 9, changedFiles: 2, reviewers: [{ name: 'alex', state: 'APPROVED', canRevoke: true, reviewId: 'demo-review', reviewUrl: `https://github.com/${repo}/pull/246#pullrequestreview-1` }, { name: 'orbit-bot', kind: 'bot', state: 'COMMENTED' }] }),
  make(256, 240, 'Update preview deployment scripts', 180, { status: 'DRAFT', checks: 'PENDING', checkCounts: { passed: 2, total: 5 },
    review: 'NONE', additions: 60, deletions: 44, dependencyParent: { id: 'not-loaded', number: 240, status: 'OPEN' },
    reviewers: [{ name: 'riley', state: 'COMMENTED' }] }),
];
items.forEach((pr, i) => {
  const total = i % 4 + 2;
  const unresolved = [0, 1, 2, 2][i % 4];
  pr.reviewThreadCounts = { resolved: total - unresolved, total };
  pr.commentCount = total + 3;
});
let visibleItems = items;
const list = async () => ({ viewer: 'alex', total: visibleItems.length, items: visibleItems, pageInfo: { hasNextPage: false } });
list.viewer = async () => 'alex';
list.reviewerSuggestions = async () => ({ reviewers: [{ name: 'riley', kind: 'user' }, { name: 'sam', kind: 'user' }], limited: false });
list.reviewCounts = async () => ({ items: visibleItems });
const viewsDir = await mkdtemp(join(tmpdir(), 'gh-pull-capture-'));
const savedViews = createSavedViewsStore(join(viewsDir, 'views.json'), () => new Date(now).toISOString());
await savedViews.change('alex', { action: 'save', name: 'Team reviews', query: 'sort:review-status', group: 'repo' });
await savedViews.change('alex', { action: 'save', name: 'To review', query: 'is:open review-requested:@me', group: 'repo' });
await savedViews.change('alex', { action: 'save', name: 'My drafts', query: 'is:open is:draft author:@me', group: 'status' });
await savedViews.changeQuickComment('alex', {action:'save', label:'Build image', body:'[docker-build]', repos:[repo]});
await savedViews.changeQuickComment('alex', {action:'save', label:'Ask for review', body:'@claude_review'});
const server = createApp({ list, savedViews });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1350 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
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
  await page.goto(`${origin}/?q=sort:review-status`);
  await page.locator('.dependency-dot').first().waitFor();
  await page.getByRole('button', { name: 'Team reviews', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.comment-total').length === 8);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.querySelector('.dependency-connector') && Number(document.querySelector('.dependency-connector').getAttribute('height')) === document.querySelector('.has-dependency-lanes').offsetHeight);
  assert.equal(await page.locator('.pr-row').count(), 8);
  assert.equal(await page.locator('.dependency-connector').getAttribute('width'), '92');
  assert.equal(await page.locator('.dependency-chip').innerText(), '↑ #240 · not loaded');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
  assert.equal(await page.locator('.saved-views-error:visible, .error-message:visible').count(), 0);
  assert.deepEqual(errors, []);
  if (!readmeOnly) {
    await page.screenshot({ path: new URL('../docs/marketplace-dashboard.png', import.meta.url).pathname });
    await copyFile(new URL('../docs/marketplace-dashboard.png', import.meta.url), new URL('../docs/demo.png', import.meta.url));
    console.log('Updated docs/marketplace-dashboard.png and docs/demo.png (3200 × 2700).');
  }

  // Crop the real UI without restyling it. A fixed clock, isolated storage, and
  // local fixtures keep the images repeatable and free of account information.
  const destination = new URL('../docs/features/', import.meta.url);
  await mkdir(destination, { recursive: true });
  async function capture(name, locators, { padding = 0, maxWidth } = {}) {
    await page.mouse.move(0, 0);
    const boxes = await Promise.all(locators.map(locator => locator.boundingBox()));
    assert.ok(boxes.every(Boolean), `${name}: all components must be visible`);
    const x = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.x)) - padding));
    const y = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.y)) - padding));
    const right = Math.min(page.viewportSize().width, Math.ceil(Math.max(...boxes.map(box => box.x + box.width)) + padding));
    const bottom = Math.min(page.viewportSize().height, Math.ceil(Math.max(...boxes.map(box => box.y + box.height)) + padding));
    await page.screenshot({ path: new URL(`${name}.png`, destination).pathname,
      clip: { x, y, width: Math.min(right - x, maxWidth ?? Infinity), height: bottom - y }, animations: 'disabled' });
  }
  // A narrower viewport makes the search panel legible at README widths.
  await page.setViewportSize({ width: 1100, height: 1350 });
  await page.getByRole('button', { name: 'To review', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#results').getAttribute('aria-busy') === 'false' && document.querySelector('.saved-view-pill[aria-pressed="true"]')?.textContent.includes('To review'));
  await capture('saved-views', [page.locator('#dashboard-controls'), page.locator('.dependency-node').first()]);

  await page.setViewportSize({ width: 1280, height: 1350 });
  visibleItems = items.slice(0, 4);
  await page.getByRole('button', { name: 'Team reviews', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#results').getAttribute('aria-busy') === 'false');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelectorAll('.pr-row').length === 4);
  await page.waitForFunction(() => document.querySelector('.dependency-connector') && Number(document.querySelector('.dependency-connector').getAttribute('height')) === document.querySelector('.has-dependency-lanes').offsetHeight);
  const stack = page.locator('.pr-group').first();
  const tableHeader = page.locator('.pr-column-header');
  const contextRows = [tableHeader, stack, page.locator('.dashboard-footer')];
  await capture('stacks', contextRows);

  const feedback = page.locator('[data-pr-id="demo-253"] .comment-count');
  assert.equal(await feedback.locator('.comment-unresolved').innerText(), '2');
  assert.equal(await feedback.locator('.comment-total').innerText(), '5');
  await feedback.focus();
  await page.clock.runFor(600);
  const feedbackTip = page.getByRole('tooltip');
  await feedbackTip.waitFor();
  await capture('unresolved-feedback', [...contextRows, feedbackTip]);
  await page.keyboard.press('Escape');

  const failed = page.locator('[data-pr-id="demo-253"] .ci-indicator');
  await failed.focus();
  const failures = page.getByRole('group', { name: 'Failed checks', exact: true });
  await failures.waitFor();
  assert.equal(await failures.getByRole('link').count(), 2);
  await capture('failed-checks', [...contextRows, failures]);
  await page.keyboard.press('Escape');

  const own = page.locator('[data-pr-id="demo-248"]');
  await own.getByRole('button', { name: /Manage reviewers/ }).click();
  const reviewers = page.getByRole('dialog', { name: 'Manage reviewers', exact: true });
  await reviewers.getByRole('button', { name: 'Request review from riley', exact: true }).click();
  await reviewers.getByRole('button', { name: 'Apply changes (1)', exact: true }).waitFor();
  await capture('reviewers', [...contextRows, reviewers]);
  await page.keyboard.press('Escape');

  await own.locator('.comment-count').click();
  const comment = page.getByRole('dialog', { name: 'Quick comment', exact: true });
  await comment.getByRole('textbox', { name: 'Comment', exact: true }).fill('The session API is ready for another look.\n\n@maya could you check the timeout handling?');
  await capture('comments', [...contextRows, comment]);
  await comment.getByRole('button', { name: 'Build image, inserts [docker-build]' }).click();
  await capture('quick-comment-presets', [...contextRows, comment]);
  await comment.getByRole('button', { name: 'Manage' }).click();
  const settings = page.locator('#quick-comment-editor');
  await settings.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await capture('preset-settings', [settings]);
  assert.deepEqual(errors, []);
  if (recordTour) {
    // Record real interactions at a fixed viewport; retain the PR context throughout.
    const recordingDir = await mkdtemp(join(tmpdir(), 'gh-pull-video-'));
    const narrationDir = process.env.GH_PULL_NARRATION_DIR;
    const scenes = narrationDir ? JSON.parse(await readFile(join(narrationDir, 'scenes.json'), 'utf8')) : null;
    const cues = [];
    const tourContext = await browser.newContext({ viewport: { width: 1920, height: 1350 },
      colorScheme: 'dark', recordVideo: { dir: recordingDir, size: { width: 1920, height: 1350 } } });
    try {
      const started = Date.now();
      const tour = await tourContext.newPage();
      tour.on('pageerror', error => errors.push(error.message));
      await tour.clock.install({ time: now });
      await tour.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/updates') return route.fulfill({ json: { update: null } });
        return route.continue();
      });
      const pause = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000));
      await tour.goto(`${origin}/?q=sort:review-status`);
      await tour.evaluate(() => { document.body.style.zoom = '1.5'; });
      await tour.locator('.dependency-dot').first().waitFor();
      async function explain(index, minimum) {
        const scene = scenes?.[index];
        cues.push({ start: (Date.now() - started) / 1000, text: scene?.text });
        await pause(Math.max(minimum, (scene?.duration ?? 0) + 0.6));
      }
      await explain(0, 5);
      await tour.getByRole('button', { name: 'To review', exact: true }).click();
      await explain(1, 4);
      await tour.getByRole('button', { name: 'Team reviews', exact: true }).click();
      await explain(2, 5);
      await tour.locator('[data-pr-id="demo-253"] .comment-count').hover();
      await tour.clock.runFor(600);
      await tour.getByRole('tooltip').waitFor();
      await explain(3, 6);
      await tour.keyboard.press('Escape');
      await tour.locator('[data-pr-id="demo-253"] .ci-indicator').hover();
      await tour.getByRole('group', { name: 'Failed checks', exact: true }).waitFor();
      await explain(4, 6);
      await tour.keyboard.press('Escape');
      const tourOwn = tour.locator('[data-pr-id="demo-248"]');
      await tourOwn.getByRole('button', { name: /Manage reviewers/ }).click();
      const manager = tour.getByRole('dialog', { name: 'Manage reviewers', exact: true });
      await manager.getByRole('button', { name: 'Request review from riley', exact: true }).click();
      await explain(5, 6);
      await tour.keyboard.press('Escape');
      await tourOwn.locator('.comment-count').click();
      await tour.getByRole('textbox', { name: 'Comment', exact: true }).pressSequentially(
        'The session API is ready for another look. @maya could you check the timeout handling?', { delay: 45 });
      await explain(6, 6);
      await tour.keyboard.press('Escape');
      await tour.mouse.move(20, 20);
      await explain(7, 3);
      assert.deepEqual(errors, []);
      const video = tour.video();
      await tourContext.close();
      const subtitle = join(recordingDir, 'captions.srt');
      const timestamp = value => new Date(value * 1000).toISOString().slice(11, 23).replace('.', ',');
      if (scenes) await writeFile(subtitle, cues.map((cue, i) =>
        `${i + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.start + scenes[i].duration)}\n${cue.text}\n`).join('\n'));
      const args = ['-y', '-i', await video.path()];
      if (scenes) for (const scene of scenes) args.push('-i', scene.path);
      if (scenes) {
        const tracks = cues.map((cue, i) => `[${i + 1}:a]adelay=${Math.round(cue.start * 1000)}:all=1[a${i}]`);
        tracks.push(`${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${scenes.length}:normalize=0,apad[audio]`);
        args.push('-filter_complex', tracks.join(';'), '-map', '0:v', '-map', '[audio]', '-c:a', 'aac', '-b:a', '192k', '-shortest');
      } else args.push('-an');
      args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        '-vf', `pad=1920:1510:0:0:color=0x0b1016,subtitles=${scenes ? subtitle : 'demo-captions.srt'}:force_style='FontName=DejaVu Sans,FontSize=8,PrimaryColour=&H00FFFFFF,Outline=0,Shadow=0,MarginV=8'`,
        new URL('../docs/demo.mp4', import.meta.url).pathname);
      execFileSync('ffmpeg', args, { stdio: 'pipe', cwd: new URL('.', import.meta.url) });
      console.log('Updated docs/demo.mp4 with the current dashboard tour.');
    } finally {
      await tourContext.close();
      await rm(recordingDir, { recursive: true, force: true });
    }
  }
  console.log('Updated seven README component screenshots in docs/features/.');
} finally {
  await browser.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await rm(viewsDir, { recursive: true, force: true });
}
