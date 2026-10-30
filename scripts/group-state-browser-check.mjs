import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './browser-fixture.mjs';

test('group collapse persists across launches, grouping changes and accounts; expanding saves too', async t => {
  let viewer = 'alice';
  const pr = { id: 'group-state', number: 1, title: 'Remember groups', repo: 'example/demo', author: 'alice', status: 'OPEN', checks: 'NONE', review: 'NONE', labels: [], reviewers: [], additions: 0, deletions: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  const list = async () => ({ viewer, items: [pr], total: 1, pageInfo: { hasNextPage: false } });
  const { page, origin, errors } = await browserFixture(t, { list, savedViews: { list: async () => [] } });
  const group = page.locator('.pr-group'), heading = group.locator('summary');
  const open = () => group.evaluate(el => el.open);
  const waitSaved = value => page.waitForFunction(value => {
    const saved = JSON.parse(localStorage.getItem('gh-pull.collapsed-groups.v1:alice'));
    return Array.isArray(saved) && saved.includes('repo:example/demo') === value;
  }, value);
  await page.goto(origin);
  await heading.waitFor();
  assert.equal(await open(), true);
  await heading.click(); await waitSaved(true);
  await page.goto(origin);
  await heading.waitFor();
  assert.equal(await open(), false);
  await page.selectOption('#group', 'author');
  assert.equal(await open(), true);
  await page.selectOption('#group', 'repo');
  assert.equal(await open(), false);
  // The same group retains its choice when reached through another query.
  await page.goto(origin + '/?q=involves%3A%40me&group=repo');
  await heading.waitFor();
  assert.equal(await open(), false);
  viewer = 'bob';
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('.pr-group')?.open);
  assert.equal(await open(), true);
  viewer = 'alice';
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('.pr-group')?.open === false);
  await heading.click(); await waitSaved(false);
  await page.goto(origin);
  await heading.waitFor();
  assert.equal(await open(), true);
  assert.deepEqual(errors, []);
});

test('bad or blocked group storage does not prevent toggling groups', async t => {
  const list = async () => ({ viewer: 'alice', items: [{ id: 'g', number: 1, title: 'Storage fallback', repo: 'example/demo', author: 'alice', status: 'OPEN', checks: 'NONE', review: 'NONE', labels: [], reviewers: [], additions: 0, deletions: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' }], total: 1, pageInfo: { hasNextPage: false } });
  const { page, origin } = await browserFixture(t, { list, savedViews: { list: async () => [] } });
  await page.addInitScript(() => localStorage.setItem('gh-pull.collapsed-groups.v1:alice', '{"invalid":true}'));
  await page.goto(origin);
  const group = page.locator('.pr-group');
  await group.waitFor();
  assert.equal(await group.evaluate(el => el.open), true);
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
  });
  await page.goto(origin);
  await group.locator('summary').click();
  assert.equal(await group.evaluate(el => el.open), false);
  await page.selectOption('#group', 'author');
  await page.selectOption('#group', 'repo');
  assert.equal(await group.evaluate(el => el.open), false);
});

test('group choices synchronize open tabs and survive closing and reopening a tab', async t => {
  const pr = { id: 'tabs', number: 1, title: 'Tab persistence', repo: 'example/demo', author: 'alice', status: 'OPEN', checks: 'NONE', review: 'NONE', labels: [], reviewers: [], additions: 0, deletions: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  const list = async () => ({ viewer: 'alice', items: [pr], total: 1, pageInfo: { hasNextPage: false } });
  const { page, origin } = await browserFixture(t, { list, savedViews: { list: async () => [] } });
  const context = page.context();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.locator('.pr-group').waitFor();
  const second = await context.newPage();
  await second.goto(origin);
  await second.locator('.pr-group').waitFor();
  await page.locator('.pr-group > summary').click();
  await second.waitForFunction(() => document.querySelector('.pr-group')?.open === false);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(origin);
  await reopened.locator('.pr-group').waitFor();
  assert.equal(await reopened.locator('.pr-group').evaluate(el => el.open), false);
  await reopened.locator('.pr-group > summary').click();
  await second.waitForFunction(() => document.querySelector('.pr-group')?.open === true);
  await reopened.close();
  await second.reload();
  await second.locator('.pr-group').waitFor();
  assert.equal(await second.locator('.pr-group').evaluate(el => el.open), true);
  // Flush a native toggle that has not dispatched before pagehide.
  await second.evaluate(() => {
    document.querySelector('.pr-group').open = false;
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });
  await second.close();
  const final = await context.newPage();
  await final.goto(origin);
  await final.locator('.pr-group').waitFor();
  assert.equal(await final.locator('.pr-group').evaluate(el => el.open), false);
});
