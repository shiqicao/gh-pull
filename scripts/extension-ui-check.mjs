import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const exec = promisify(execFile);
test('packaged dashboard works in a browser without source assets or external requests', async t => {
  const binary = resolve(process.env.GH_PULL_BINARY || 'dist/gh-pull-linux-amd64');
  const dir = await mkdtemp(join(tmpdir(), 'gh-pull-ui-'));
  const env = { ...process.env, GH_PULL_STATE_DIR: dir, GH_TOKEN: 'fixture-unused-token', GITHUB_TOKEN: '' };
  const command = (...args) => exec(binary, args, { env, cwd: tmpdir(), timeout: 25_000 });
  t.after(async () => { await command('stop'); await rm(dir, { recursive: true, force: true }); });
  const { stdout } = await command('--no-open');
  const origin = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (/Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text()); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/pulls') return route.fulfill({ json: {
      viewer: 'alice', total: 1, pageInfo: { hasNextPage: false }, items: [{
        id: 'fixture', number: 42, title: 'Launch the local dashboard', url: 'https://github.com/example/dashboard/pull/42',
        repo: 'example/dashboard', author: 'alice', status: 'OPEN', branch: 'feature/cli',
        additions: 120, deletions: 35, changedFiles: 8, commentCount: 4,
        createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T01:00:00Z', checks: 'SUCCESS', review: 'NONE', reviewers: [], labels: [],
      }],
    } });
    if (url.pathname.startsWith('/api/pulls/')) return route.abort();
    return route.continue();
  });
  await page.goto(origin);
  await page.locator('.pr-row').waitFor();
  assert.equal(await page.locator('.pr-files .file-count').textContent(), '8');
  await page.evaluate(() => document.fonts.ready);
  assert.match(await page.locator('body').evaluate(node => getComputedStyle(node).fontFamily), /-apple-system.*BlinkMacSystemFont.*Segoe UI/);
  const artifacts = process.env.BROWSER_ARTIFACT_DIR || '/tmp/gh-pull-extension-browser';
  await mkdir(artifacts, { recursive: true });
  for (const colorScheme of ['light', 'dark']) for (const width of [1440, 375]) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `Packaged dashboard must fit at ${width}px in ${colorScheme} mode`);
    await page.screenshot({ path: join(artifacts, `extension-${colorScheme}-${width}.png`), fullPage: true });
  }
  await page.locator('.cm-content').fill('repo:');
  assert.equal(await page.locator('#query-feedback').textContent(), 'Add a value after repo:');
  assert.deepEqual(errors, []);
});
