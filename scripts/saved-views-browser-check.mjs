import test from 'node:test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSavedViewsStore } from '../saved-views.js';
import { browserFixture } from './browser-fixture.mjs';

async function setup(t, seed = true) {
  const dir = await mkdtemp(join(tmpdir(), 'saved-views-browser-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createSavedViewsStore(join(dir, 'views.json'), () => '2026-01-01T00:00:00.000Z');
  if (seed) {
    await store.change('alice', { action: 'save', name: 'My work', query: 'is:open author:@me', group: 'author' });
    await store.change('alice', { action: 'save', name: 'To review', query: 'is:open review-requested:@me', group: 'repo' });
  }
  if (seed === 10) for (const [index, name] of ['CI', 'Team backend', 'Waiting on review', 'Documentation', 'Release 2.4', 'Dependabot', 'Stale pull requests', 'A long saved view name that needs to fit on a narrow mobile screen'].entries()) {
    await store.change('alice', { action: 'save', name, query: `is:open label:fixture-${index}`, group: 'repo' });
  }
  const queries = [];
  const list = async ({ query }) => { queries.push(query); return { viewer: 'alice', items: [], total: 0, pageInfo: { hasNextPage: false } }; };
  list.viewer = async () => 'alice';
  const fixture = await browserFixture(t, { list, savedViews: store });
  const { page, origin } = fixture;
  await page.goto(`${origin}/?q=is%3Aopen%20author%3A%40me&group=author`);
  await page.waitForFunction(() => { const button = document.querySelector('#save-view-new'); return button && !button.disabled; });
  return { ...fixture, store, queries, panel: page.locator('#saved-views-panel'), editor: page.locator('.cm-content') };
}

test('searching and saving are explicit, with stable controls and applied-query-only saves', async t => {
  const { page, store, editor, queries, errors } = await setup(t);
  const save = page.locator('#save-view'), create = page.locator('#save-view-new');
  assert.equal(await save.isDisabled(), true);
  const centers = await page.locator('.saved-view-pill').evaluateAll(buttons => buttons.map(button => {
    const outer = button.getBoundingClientRect(), label = button.firstElementChild.getBoundingClientRect();
    return Math.abs((outer.left + outer.right - label.left - label.right) / 2);
  }));
  assert.ok(centers.every(offset => offset < 1), 'Pill labels are centered with space reserved for the edit dot');
  const before = await editor.boundingBox();
  const searched = queries.length;
  let writes = 0, searches = 0;
  page.on('request', req => { if (req.url().includes('/api/saved-views') && req.method() === 'POST') writes++; if (new URL(req.url()).pathname === '/api/pulls') searches++; });
  await editor.fill('is:closed author:@me');
  assert.equal(await save.isDisabled(), true);
  assert.equal(await create.isDisabled(), true);
  assert.match(await page.locator('#saved-view-status').textContent(), /Apply your query with Search or Enter before saving/);
  await editor.press('Control+s');
  assert.equal(writes, 0); assert.equal(searches, 0); assert.equal(queries.length, searched);
  assert.equal((await store.list('alice'))[0].query, 'is:open author:@me');
  await page.locator('#query-submit').click();
  await page.waitForFunction(() => !document.querySelector('#save-view').disabled);
  assert.equal(writes, 0);
  assert.equal((await store.list('alice'))[0].query, 'is:open author:@me');
  assert.match(await page.locator('#saved-view-status').textContent(), /Edited query/);
  assert.deepEqual(await editor.boundingBox(), before);
  const beforeSave = searches;
  await save.click();
  await page.waitForFunction(() => document.querySelector('#saved-view-status').textContent.includes('Saved “My work”'));
  assert.equal(searches, beforeSave);
  assert.equal((await store.list('alice'))[0].query, 'is:closed author:@me');
  assert.equal(await save.isDisabled(), true);
  await page.locator('#group').selectOption('status');
  assert.equal(await save.isEnabled(), true);
  assert.equal((await store.list('alice'))[0].group, 'author');
  await page.screenshot({ path: '/tmp/gh-pull-view-pills-desktop.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/gh-pull-view-pills-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => { const button = document.querySelector('#save-view'); return button.disabled && button.textContent === 'Save changes'; });
  assert.equal((await store.list('alice'))[0].group, 'status');
  assert.deepEqual(errors, []);
});

test('selected view arrow and More toggle their popup closed', async t => {
  const { page, panel, errors } = await setup(t, 10);
  const pill = page.locator('.saved-view-pill[aria-pressed="true"]');
  const arrow = pill.locator('.saved-view-arrow');
  const more = page.locator('.saved-view-more');
  for (const [target, trigger] of [[arrow, pill], [more, more]]) {
    await target.click();
    assert.equal(await panel.isVisible(), true);
    await target.click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.focus();
    await page.keyboard.press('Enter');
    assert.equal(await panel.isVisible(), true);
    await trigger.focus();
    await page.keyboard.press('Enter');
    assert.equal(await panel.isVisible(), false);
  }
  await arrow.click();
  await panel.getByRole('button', { name: 'Rename…' }).click();
  await arrow.click();
  assert.equal(await panel.isVisible(), false);
  assert.deepEqual(errors, []);
});

test('view selection, revert, discarded-edit undo, rename, delete and delete undo', async t => {
  const { page, store, editor, panel, errors } = await setup(t);
  await page.locator('#group').selectOption('status');
  await page.getByRole('button', { name: 'My work', exact: true }).click();
  await panel.getByRole('button', { name: 'Rename…' }).waitFor();
  assert.equal(await page.locator('#group').inputValue(), 'status');
  await page.screenshot({ path: '/tmp/gh-pull-pill-menu.png', fullPage: true });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'My work', exact: true }).getAttribute('aria-expanded'), 'false');
  await editor.fill('repo:unapplied/draft');
  await page.getByRole('button', { name: 'To review', exact: true }).click();
  assert.equal(await editor.innerText(), 'is:open review-requested:@me');
  assert.equal(await page.locator('#group').inputValue(), 'repo');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await editor.innerText(), 'repo:unapplied/draft');
  assert.equal(await page.locator('#group').inputValue(), 'status');
  assert.equal(new URL(page.url()).searchParams.get('q'), 'is:open author:@me');
  assert.equal(await page.locator('#save-view').isDisabled(), true);
  await editor.fill('is:open author:@me');
  await page.getByRole('button', { name: 'Revert', exact: true }).click();
  assert.equal(await page.locator('#group').inputValue(), 'author');
  await page.locator('.saved-view-pill[aria-pressed="true"]').click();
  await panel.getByRole('button', { name: 'Rename…' }).click();
  await panel.getByRole('textbox', { name: 'View name' }).fill('Authored');
  await panel.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('button', { name: 'Authored', exact: true }).waitFor();
  const original = await store.list('alice');
  await page.locator('.saved-view-pill[aria-pressed="true"]').click();
  await panel.getByRole('button', { name: 'Delete…' }).click();
  await panel.getByRole('button', { name: 'Delete view', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Authored', exact: true }).waitFor();
  assert.deepEqual(await store.list('alice'), original);
  assert.equal(await editor.innerText(), 'is:open author:@me');
  assert.deepEqual(errors, []);
});

test('first save, save as new, failed-save retry, and blocked saving of unapplied text', async t => {
  const { page, store, editor, panel, errors } = await setup(t, false);
  await page.locator('#save-view-new').click();
  await panel.getByRole('textbox', { name: 'View name' }).fill('First view');
  await page.screenshot({ path: '/tmp/gh-pull-save-popup-desktop.png', fullPage: true });
  const popupBox = await panel.boundingBox(), footerBox = await page.locator('#saved-view-footer').boundingBox();
  assert.ok(Math.abs(popupBox.x + popupBox.width - footerBox.x - footerBox.width) < 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '/tmp/gh-pull-save-popup-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ colorScheme: 'light' });
  await panel.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('button', { name: 'First view', exact: true }).waitFor();
  await page.locator('#group').selectOption('none');
  await page.locator('#save-view-new').click();
  await panel.getByRole('textbox', { name: 'View name' }).fill('Flat view');
  await panel.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('button', { name: 'Flat view', exact: true }).waitFor();
  assert.equal((await store.list('alice'))[0].group, 'author');
  let fail = true;
  await page.route('**/api/saved-views', route => {
    if (route.request().method() === 'POST' && fail) { fail = false; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Disk unavailable.' }) }); }
    return route.continue();
  });
  await page.locator('#group').selectOption('checks');
  await page.locator('#save-view').click();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  assert.equal(await page.locator('#group').inputValue(), 'checks');
  assert.equal((await store.list('alice'))[1].group, 'none');
  await editor.fill('is:closed author:@me');
  assert.equal(await page.locator('#save-view').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).count(), 0);
  await editor.fill('is:open author:@me');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#saved-view-status').textContent.includes('Saved “Flat view”'));
  assert.equal((await store.list('alice'))[1].group, 'checks');
  await page.reload();
  await page.getByRole('button', { name: 'First view', exact: true }).click();
  assert.equal(await page.locator('#group').inputValue(), 'author');
  assert.deepEqual(errors, []);
});

test('overflow stays on one row, keeps selection visible, and anchors rename to the selected pill', async t => {
  const { page, editor, panel, errors } = await setup(t, 10);
  const more = page.locator('.saved-view-more');
  await more.waitFor();
  const short = await page.getByRole('button', { name: 'CI', exact: true }).boundingBox();
  const longer = await page.getByRole('button', { name: 'My work', exact: true }).boundingBox();
  assert.ok(short.width < longer.width, 'Pill width follows the label');
  await page.screenshot({ path: '/tmp/gh-pull-views-overflow-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await more.click();
  const longName = 'A long saved view name that needs to fit on a narrow mobile screen';
  await panel.getByRole('button', { name: longName, exact: true }).click();
  assert.equal(await editor.innerText(), 'is:open label:fixture-7');
  assert.deepEqual(errors, []);
  const selected = page.locator('.saved-view-pill[aria-pressed="true"]');
  assert.equal(await selected.isVisible(), true, JSON.stringify(await page.locator('.saved-view-pill').evaluateAll(buttons => buttons.map(b => ({ text: b.textContent, hidden: b.hidden, active: b.getAttribute('aria-pressed'), width: b.getBoundingClientRect().width, style: b.getAttribute('style') })))));
  await page.waitForFunction(() => document.querySelector('.saved-view-pill[aria-pressed="true"]') === document.activeElement);
  const visible = page.locator('.saved-view-pill:visible');
  const hiddenCount = 10 - await visible.count();
  assert.ok((await more.textContent()).includes(`More (${hiddenCount})`));
  const boxes = await visible.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().top));
  assert.ok(boxes.every(y => y === boxes[0]));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await selected.click();
  await panel.getByRole('button', { name: 'Rename…' }).click();
  await page.screenshot({ path: '/tmp/gh-pull-views-overflow-rename.png', fullPage: true });
  const pillBox = await selected.boundingBox(), dialogBox = await panel.boundingBox();
  assert.equal(Math.round(dialogBox.y), Math.round(pillBox.y + pillBox.height + 6));
  assert.equal(Math.round(dialogBox.x), Math.round(pillBox.x));
  await panel.getByRole('textbox', { name: 'View name' }).fill('Long view renamed');
  await panel.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('button', { name: 'Long view renamed', exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/gh-pull-views-overflow-mobile.png', fullPage: true });
  await more.click();
  await panel.getByRole('button', { name: 'My work', exact: true }).waitFor();
  await page.setViewportSize({ width: 2500, height: 1000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.saved-view-pill')].filter(button => !button.hidden).length > 2);
  assert.equal(await page.locator('.saved-view-pill[aria-pressed="true"]').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#saved-views-panel:popover-open').count(), 0);
  assert.deepEqual(errors, []);
});

 test('usage survives reload without reordering the current session or counting menu clicks', async t => {
  const { page, store, panel } = await setup(t);
  const order = () => page.locator('.saved-view-pill').evaluateAll(pills => pills.map(p => p.dataset.viewId));
  const before = await order();
  const response = page.waitForResponse(res => res.url().endsWith('/api/saved-views') && res.request().postDataJSON()?.action === 'load');
  await page.getByRole('button', { name: 'To review', exact: true }).click();
  await response;
  assert.deepEqual(await order(), before);
  let view = (await store.list('alice')).find(v => v.name === 'To review');
  assert.equal(view.loadCount, 1);
  assert.ok(view.lastLoadedAt);
  await page.getByRole('button', { name: 'To review', exact: true }).click();
  await panel.getByRole('button', { name: 'Rename…' }).waitFor();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.saved-view-pill'));
  assert.equal((await order())[0], view.id);
  view = (await store.list('alice')).find(v => v.id === view.id);
  assert.equal(view.loadCount, 1);
});

test('failed usage tracking keeps navigation working and clears its warning after recovery', async t => {
  const { page, store, editor, errors } = await setup(t);
  let fail = true;
  await page.route('**/api/saved-views', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'load' && fail) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Unavailable' }) });
    }
    return route.continue();
  });
  await page.getByRole('button', { name: 'To review', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#saved-view-status').textContent.includes('usage could not be saved'));
  assert.equal(await editor.innerText(), 'is:open review-requested:@me');
  assert.equal((await store.list('alice')).find(v => v.name === 'To review').loadCount, 0);
  fail = false;
  await page.getByRole('button', { name: 'My work', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#saved-view-status').textContent.includes('usage could not be saved'));
  assert.equal((await store.list('alice')).find(v => v.name === 'My work').loadCount, 1);
  assert.deepEqual(errors, []);
});

test('rapid selection with delayed usage writes preserves the final query, counts and explicit save', async t => {
  const { page, store, editor, errors } = await setup(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let started;
  const intercepted = new Promise(resolve => { started = resolve; });
  let first = true;
  await page.route('**/api/saved-views', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'load' && first) {
      first = false; started(); await gate;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'To review', exact: true }).click();
  await intercepted;
  await page.getByRole('button', { name: 'My work', exact: true }).click();
  await page.getByRole('button', { name: 'To review', exact: true }).click();
  assert.equal(await editor.innerText(), 'is:open review-requested:@me');
  await page.locator('#group').selectOption('checks');
  await page.locator('#save-view').click();
  release();
  await page.waitForFunction(() => document.querySelector('#saved-view-status').textContent.includes('Saved “To review”'));
  const views = await store.list('alice');
  assert.equal(views.find(v => v.name === 'To review').loadCount, 2);
  assert.equal(views.find(v => v.name === 'My work').loadCount, 1);
  assert.equal(views.find(v => v.name === 'To review').group, 'checks');
  assert.equal(await editor.innerText(), 'is:open review-requested:@me');
  assert.deepEqual(errors, []);
});

test('saved-view menus dismiss outside and remain usable at narrow widths and enlarged text', async t => {
  const { page, panel, errors } = await setup(t, 10);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('body').evaluate(body => { body.style.zoom = '1.25'; });
    const selected = page.locator('.saved-view-pill[aria-pressed="true"]');
    assert.equal(await selected.isVisible(), true);
    await selected.click();
    await panel.getByRole('button', { name: 'Rename…' }).waitFor();
    const box = await panel.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width, `Popup fits at ${width}px`);
    await page.locator('h1').click();
    assert.equal(await panel.isVisible(), false);
    await page.locator('.saved-view-more').click();
    await page.keyboard.press('Escape');
    assert.equal(await panel.isVisible(), false);
  }
  assert.deepEqual(errors, []);
});

test('saved views and their menus/forms pass accessibility checks in both themes', async t => {
  const { page, panel } = await setup(t, 10);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    const audit = async selector => {
      const result = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      assert.deepEqual(result.violations, []);
    };
    await audit('.search-panel');
    await page.locator('.saved-view-pill[aria-pressed="true"]').click();
    await audit('#saved-views-panel');
    await panel.getByRole('button', { name: 'Rename…' }).click();
    await audit('#saved-views-panel');
    await page.keyboard.press('Escape');
    await page.locator('#save-view-new').click();
    await audit('#saved-views-panel');
    await page.keyboard.press('Escape');
    await page.locator('.saved-view-more').click();
    await audit('#saved-views-panel');
    await page.keyboard.press('Escape');
  }
});
