import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { browserFixture } from './browser-fixture.mjs';
import { scenario3a, scenario3b } from './dependency-fixtures.mjs';

for (const [name, items, width, nodes] of [['3a', scenario3a, 92, 8], ['3b', scenario3b, 52, 6]]) {
  test(`handoff ${name}: flat rows, lane geometry, themes, responsive zoom and collapse`, async t => {
    const { page, origin, errors } = await browserFixture(t, { list: async () => ({ viewer: 'viewer', total: items.length,
      items: [...items].reverse(), pageInfo: { hasNextPage: false } }) });
    await page.goto(origin); await page.locator('.dependency-dot').first().waitFor();
    assert.equal(await page.locator('.dependency-dot').count(), nodes);
    assert.deepEqual(await page.locator('.pr-row').evaluateAll(rows => rows.map(r => r.dataset.prId)), items.map(pr => pr.id));
    assert.equal(await page.locator('.dependency-connector').getAttribute('width'), String(width));
    if (name === '3b') {
      assert.equal(await page.locator('.dependency-chip').innerText(), '↑ #488 · not loaded');
      assert.equal(await page.locator('.dependency-external').count(), 1);
    }
    await mkdir('/tmp/gh-pull-lanes', { recursive: true });
    for (const theme of ['dark', 'light']) for (const viewport of [1280, 375, 320]) {
      await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width: viewport, height: 1000 });
      await page.waitForFunction(() => {
        const list = document.querySelector('.has-dependency-lanes');
        return Number(document.querySelector('.dependency-connector').getAttribute('height')) === list.offsetHeight;
      });
      const lefts = await page.locator('.pr-row').evaluateAll(rows => rows.map(r => r.getBoundingClientRect().left));
      assert.ok(lefts.every(x => x === lefts[0]));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `/tmp/gh-pull-lanes/${name}-${theme}-${viewport}.png`, fullPage: true });
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1000, height: 1000 });
    for (const zoom of [1.25, 1.5, 2]) {
      await page.evaluate(value => { document.documentElement.style.zoom = value; }, zoom);
      await page.waitForFunction(() => {
        const list = document.querySelector('.has-dependency-lanes');
        return Number(document.querySelector('.dependency-connector').getAttribute('height')) === list.offsetHeight;
      });
      await page.locator('.pr-group').screenshot({ path: `/tmp/gh-pull-lanes/${name}-zoom-${zoom}.png` });
    }
    await page.locator('.pr-group > summary').click();
    await page.locator('.dependency-dot').first().waitFor({ state: 'hidden' });
    await page.locator('.pr-group > summary').click();
    await page.locator('.dependency-dot').first().waitFor();
    assert.equal(await page.locator('.dependency-dot').count(), nodes);
    const audit = await new AxeBuilder({ page }).include('.has-dependency-lanes').analyze();
    assert.deepEqual(audit.violations, []);
    assert.deepEqual(errors, []);
  });
}

test('wide trees fall back to parent chips and a retargeted standalone group drops its gutter', async t => {
  const root = scenario3a[0];
  let items = [root, ...Array.from({ length: 6 }, (_, i) => ({ ...scenario3a[1], id: `wide-${i}`, number: 600 + i, branch: `wide-${i}` }))];
  const { page, origin, errors } = await browserFixture(t, { list: async () => ({ viewer: 'viewer', total: items.length, items, pageInfo: { hasNextPage: false } }) });
  await page.goto(origin); await page.locator('.dependency-dot').first().waitFor();
  assert.equal(await page.locator('.dependency-connector').getAttribute('width'), '92');
  assert.equal(await page.locator('.dependency-chip').count(), 2);
  assert.deepEqual(await page.locator('.dependency-chip').allTextContents(), ['↑ #495', '↑ #495']);
  items = items.map(pr => ({ ...pr, baseBranch: 'main' }));
  await page.locator('#refresh').click();
  await page.locator('.dependency-connector').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.dependency-gutter').count(), 0);
  assert.equal(await page.locator('.pr-row').count(), items.length);
  assert.deepEqual(errors, []);
});

test('parent labels track merged and closed states after refresh without a merged connector', async t => {
  let parentState = 'OPEN';
  const child = { ...scenario3a[1], dependencyParent: { id: 'parent', number: 42, status: 'OPEN' } };
  const { page, origin, errors } = await browserFixture(t, {
    list: async () => ({ viewer: 'viewer', total: 1, items: [{ ...child, dependencyParent: { ...child.dependencyParent, status: parentState } }], pageInfo: { hasNextPage: false } }),
  });
  await page.goto(origin);
  const chip = page.locator('.dependency-chip');
  await chip.waitFor();
  assert.equal(await chip.getAttribute('aria-description'), await chip.getAttribute('data-tooltip'));
  await chip.waitFor();
  assert.equal(await chip.innerText(), '↑ #42 · not loaded');
  assert.equal(await page.locator('.dependency-external').count(), 1);
  for (const state of ['MERGED', 'CLOSED', 'OPEN']) {
    parentState = state;
    await page.locator('#refresh').click();
    await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
    assert.equal(await chip.innerText(), `↑ #42 · ${state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'not loaded'}`);
    assert.equal(await page.locator('.dependency-external').count(), state === 'MERGED' ? 0 : 1);
    if (state === 'MERGED') {
      assert.equal(await page.locator('.dependency-connector').count(), 0);
      await page.screenshot({ path: '/tmp/gh-pull-merged-parent.png', fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
});

test('merging a loaded parent updates its child immediately and refreshes without restoring stale metadata', async t => {
  const parent = { ...scenario3a[0], canMerge: true, mergeMethod: 'SQUASH', mergeMethods: ['SQUASH'], headOid: 'a'.repeat(40) };
  const child = { ...scenario3a[1], dependencyParent: { id: parent.id, number: parent.number, status: 'OPEN' } };
  let reads = 0, merged = false, release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { page, origin, errors } = await browserFixture(t, {
    list: async () => {
      reads++;
      if (merged) await held;
      return { viewer: 'alice', total: 2, items: [parent, child], pageInfo: { hasNextPage: false } };
    },
    merge: async () => { merged = true; return { id: parent.id, status: 'MERGED', canMerge: false, updatedAt: new Date().toISOString() }; },
  });
  await page.goto(origin);
  await page.locator('.merge-action').click();
  await page.waitForFunction(() => document.querySelector('.dependency-chip')?.textContent === '↑ #495 · merged');
  assert.equal(await page.locator('.dependency-external').count(), 0);
  assert.equal(await page.locator('.pr-row').count(), 1);
  const before = reads;
  await page.waitForFunction(() => document.querySelector('#refresh').disabled);
  release();
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  assert.ok(reads >= 2 && reads >= before, 'merge triggers a list refresh');
  assert.equal(await page.locator('.dependency-chip').innerText(), '↑ #495 · merged');
  assert.equal(await page.locator('.pr-row').count(), 1);
  assert.deepEqual(errors, []);
});

test('non-default base without an identifiable PR shows base not loaded until retargeted', async t => {
  let baseBranch = 'merge-train/spartan';
  const { page, origin, errors } = await browserFixture(t, {
    list: async () => ({ viewer: 'viewer', total: 1, items: [{ ...scenario3a[1], title: 'refactor: split wallet fee option calculation',
      baseBranch, defaultBranch: 'next', dependencyParent: null }], pageInfo: { hasNextPage: false } }),
  });
  await page.goto(origin);
  const chip = page.locator('.dependency-chip');
  await chip.waitFor();
  assert.equal(await chip.getAttribute('aria-description'), await chip.getAttribute('data-tooltip'));
  await chip.waitFor();
  assert.equal(await chip.innerText(), '↑ base not loaded');
  assert.match(await chip.getAttribute('data-tooltip'), /merge-train\/spartan/);
  assert.equal(await page.locator('.dependency-edge').count(), 0);
  assert.equal(await page.locator('.dependency-external').count(), 1);
  assert.equal(await page.locator('.dependency-dot').count(), 1);
  assert.equal(await page.locator('.dependency-connector').getAttribute('width'), '32');
  baseBranch = 'next';
  await page.locator('#refresh').click();
  await chip.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.dependency-connector').count(), 0);
  assert.deepEqual(errors, []);
});
