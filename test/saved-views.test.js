import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSavedViewsStore, rankSavedViews } from '../saved-views.js';
import { createApp } from '../server.js';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gh-pull-views-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'saved-views.json');
  return { path, store: createSavedViewsStore(path) };
}
test('saved views persist, preserve order, isolate accounts and reject duplicates', async t => {
  const { store, path } = await fixture(t);
  assert.deepEqual(await store.list('alice'), []);
  const [first] = await store.change('Alice', { action: 'save', name: 'Reviews', query: 'review-requested:@me' });
  await store.change('alice', { action: 'save', name: 'Mine', query: 'author:@me' });
  await assert.rejects(store.change('alice', { action: 'save', name: 'Again', query: ' author:@me ' }), { status: 409 });
  await store.change('alice', { action: 'rename', id: first.id, name: 'To review' });
  await store.change('alice', { action: 'update', id: first.id, query: 'is:open review-requested:@me' });
  const reloaded = createSavedViewsStore(path);
  assert.deepEqual((await reloaded.list('ALICE')).map(v => v.name), ['To review', 'Mine']);
  assert.deepEqual(await reloaded.list('bob'), []);
  await reloaded.change('alice', { action: 'delete', id: first.id });
  assert.equal((await store.list('alice')).length, 1);
  await assert.rejects(store.change('alice', { action: 'rename', id: first.id, name: 'Gone' }), { status: 404 });
});
test('concurrent stores preserve updates and a damaged file is never overwritten', async t => {
  const { store, path } = await fixture(t);
  await Promise.all([store.change('alice', { action: 'save', name: 'One', query: 'repo:a/b' }), createSavedViewsStore(path).change('bob', { action: 'save', name: 'Two', query: 'repo:a/c' })]);
  assert.equal((await store.list('alice')).length, 1);
  assert.equal((await store.list('bob')).length, 1);
  await writeFile(path, 'broken');
  await assert.rejects(store.change('alice', { action: 'save', name: 'Three', query: 'is:open' }));
  assert.equal(await readFile(path, 'utf8'), 'broken');
});
test('saved views API checks origin, payload and server-derived account', async t => {
  const { store } = await fixture(t);
  const list = async () => ({}); list.viewer = async () => 'alice';
  const server = createApp({ list, savedViews: store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body, extra = {}) => fetch(`${origin}/api/saved-views`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'save', account: 'alice', name: 'Mine', query: 'author:@me' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ action: 'save', account: 'bob', name: 'Mine', query: 'author:@me' })).status, 409);
  assert.equal((await post({ action: 'save', account: 'alice', name: '', query: 'author:@me' })).status, 400);
  assert.equal((await post({ action: 'save', account: 'alice', name: 'Mine', query: 'repo:' })).status, 400);
  assert.equal((await post({ action: 'save', account: 'alice', name: 'Mine', query: 'author:@me' })).status, 200);
  const data = await (await fetch(`${origin}/api/saved-views`)).json();
  assert.equal(data.account, 'alice'); assert.equal(data.views[0].name, 'Mine');
});
test('views save grouping, allow distinct groupings, and default legacy views to repository grouping', async t => {
  const { store, path } = await fixture(t);
  await writeFile(path, JSON.stringify({ version: 1, accounts: [{ login: 'alice', views: [{ id: 'legacy', name: 'Old', query: 'is:open' }] }] }));
  await assert.rejects(store.change('alice', { action: 'save', name: 'Duplicate', query: 'is:open', group: 'repo' }), { status: 409 });
  const views = await store.change('alice', { action: 'save', name: 'By author', query: 'is:open', group: 'author' });
  assert.equal(views[1].group, 'author');
  await store.change('alice', { action: 'update', id: 'legacy', query: 'is:open', group: 'none' });
  assert.equal((await createSavedViewsStore(path).list('alice'))[0].group, 'none');
  await assert.rejects(store.change('alice', { action: 'save', name: 'Invalid', query: 'is:closed', group: 'invalid' }), { status: 400 });
});
test('undo deletion restores the same view and position without overwriting another view', async t => {
  const { store } = await fixture(t);
  const [view] = await store.change('alice', { action: 'save', name: 'First', query: 'author:@me' });
  await store.change('alice', { action: 'save', name: 'Second', query: 'review-requested:@me' });
  await store.change('alice', { action: 'delete', id: view.id });
  await store.change('alice', { ...view, action: 'restore', position: 0 });
  assert.equal((await store.list('alice'))[0].id, view.id);
  await assert.rejects(store.change('alice', { ...view, action: 'restore', position: 0 }), { status: 409 });
});

test('ranking reserves favorites, boosts fresh/edit/recent use, decays boosts and keeps ties stable', () => {
  const now = Date.parse('2026-10-20T00:00:00Z'), recent = new Date(now).toISOString();
  const old = '2020-01-01T00:00:00Z';
  const views = [
    { id: 'legacy' }, { id: 'tie' },
    { id: 'fresh', createdAt: recent },
    { id: 'edited', lastEditedAt: recent },
    { id: 'clicked', lastLoadedAt: recent },
    { id: 'favorite', loadCount: 100, createdAt: old },
    { id: 'second', loadCount: 50, createdAt: old },
    { id: 'regular', loadCount: 1 },
  ];
  assert.deepEqual(rankSavedViews(views, now).map(v => v.id), ['favorite', 'second', 'clicked', 'fresh', 'edited', 'regular', 'legacy', 'tie']);
  assert.equal(rankSavedViews(views, now + 90 * 86400000)[2].id, 'regular');
});

test('history persists across stores, concurrent loads accumulate, edits and undo preserve usage', async t => {
  const { path } = await fixture(t);
  let date = '2026-10-01T00:00:00Z';
  const store = createSavedViewsStore(path, () => date);
  const [view] = await store.change('alice', { action: 'save', name: 'Mine', query: 'author:@me' });
  assert.equal(view.createdAt, date);
  assert.equal(view.lastEditedAt, null);
  date = '2026-10-20T00:00:00Z';
  await Promise.all(Array.from({ length: 4 }, () => createSavedViewsStore(path, () => date).change('alice', { action: 'load', id: view.id })));
  await store.change('alice', { action: 'rename', id: view.id, name: 'Renamed' });
  let [saved] = await store.list('alice');
  assert.equal(saved.loadCount, 4);
  assert.equal(saved.lastLoadedAt, date);
  assert.equal(saved.lastEditedAt, null);
  await store.change('alice', { action: 'update', id: view.id, query: view.query, group: 'author' });
  [saved] = await store.list('alice');
  assert.equal(saved.lastEditedAt, date);
  date = '2026-10-21T00:00:00Z';
  await store.change('alice', { action: 'update', id: view.id, query: view.query, group: 'author' });
  assert.equal((await store.list('alice'))[0].lastEditedAt, saved.lastEditedAt);
  await store.change('alice', { action: 'delete', id: view.id });
  await store.change('alice', { ...saved, action: 'restore', position: 0 });
  assert.deepEqual((await createSavedViewsStore(path).list('alice'))[0], saved);
  assert.deepEqual(await store.list('bob'), []);
});

test('legacy views acquire usage safely and invalid or cross-account writes leave data intact', async t => {
  const { store, path } = await fixture(t);
  await writeFile(path, JSON.stringify({ version: 1, accounts: [{ login: 'alice', views: [{ id: 'legacy', name: 'Old', query: 'is:open' }] }] }));
  const [view] = await store.change('alice', { action: 'load', id: 'legacy', loadCount: 10000 });
  assert.equal(view.loadCount, 1);
  assert.equal(view.createdAt, null);
  assert.ok(view.lastLoadedAt);
  const before = await readFile(path, 'utf8');
  await assert.rejects(store.change('bob', { action: 'load', id: 'legacy' }), { status: 404 });
  await assert.rejects(store.change('alice', { action: 'restore', id: 'bad', position: -1, name: 'Bad', query: 'is:open' }), { status: 400 });
  await assert.rejects(store.change('alice', { action: 'unknown' }), { status: 400 });
  assert.equal(await readFile(path, 'utf8'), before);
});
