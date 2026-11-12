import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSavedViewsStore, rankSavedViews } from '../saved-views.js';
import { createApp } from '../server.js';
async function fixture(t, existing = true) {
  const dir = await mkdtemp(join(tmpdir(), 'gh-pull-views-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'saved-views.json');
  if (existing) await writeFile(path, JSON.stringify({ version: 1, accounts: [{ login: 'alice', views: [] }, { login: 'bob', views: [] }] }));
  return { path, store: createSavedViewsStore(path) };
}
test('new accounts receive a persistent mine view, while deleted and existing views stay intact', async t => {
  const { path, store } = await fixture(t, false);
  assert.deepEqual(await store.list(''), []);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  const [mine] = await store.list('Alice');
  assert.deepEqual({ ...mine, id: 'id', createdAt: 'date' }, {
    id: 'id', name: 'mine', query: 'is:open involves:@me sort:updated-desc', group: 'repo',
    loadCount: 0, createdAt: 'date', lastEditedAt: null, lastLoadedAt: null,
  });
  assert.match(mine.id, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(mine.createdAt)));
  assert.deepEqual(await createSavedViewsStore(path).list('ALICE'), [mine]);
  const [bob] = await store.list('bob');
  assert.equal(bob.name, 'mine');
  assert.notEqual(bob.id, mine.id);
  await store.change('alice', { action: 'delete', id: mine.id });
  assert.deepEqual(await createSavedViewsStore(path).list('alice'), []);
  assert.deepEqual(JSON.parse(await readFile(path)).accounts.find(a => a.login === 'alice').views, []);
  assert.deepEqual(await store.list('bob'), [bob]);
  await store.change('bob', { action: 'rename', id: bob.id, name: 'My queue' });
  assert.deepEqual((await createSavedViewsStore(path).list('bob')).map(v => v.name), ['My queue']);
});

test('concurrent initialization and saves preserve one default per new account', async t => {
  const { path, store } = await fixture(t, false);
  const other = createSavedViewsStore(path);
  const [first, second] = await Promise.all([store.list('alice'), other.list('ALICE')]);
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  await Promise.all([
    store.list('bob'),
    other.change('bob', { action: 'save', name: 'Authored', query: 'author:@me' }),
    store.list('charlie'),
  ]);
  assert.deepEqual((await store.list('bob')).map(v => v.name), ['mine', 'Authored']);
  assert.equal((await store.list('charlie')).length, 1);
  assert.equal(JSON.parse(await readFile(path)).accounts.length, 3);
});

test('initialization explains unwritable directories without changing existing accounts', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const { path, store } = await fixture(t, false);
  const original = await store.list('alice');
  const before = await readFile(path, 'utf8');
  await chmod(dirname(path), 0o500);
  try {
    assert.deepEqual(await store.list('alice'), original);
    await assert.rejects(store.list('bob'), error => {
      assert.equal(error.status, 500);
      assert.match(error.message, /Check write permissions/);
      assert.ok(error.message.includes(path));
      assert.equal(error.cause.code, 'EACCES');
      return true;
    });
    assert.equal(await readFile(path, 'utf8'), before);
  } finally { await chmod(dirname(path), 0o700); }
  assert.equal((await store.list('bob'))[0].name, 'mine');
});

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
test('saved views API explains runtime config corruption, preserves the file and recovers after repair', async t => {
  const { store, path } = await fixture(t);
  await store.change('alice', { action: 'save', name: 'Mine', query: 'author:@me' });
  const original = await readFile(path, 'utf8');
  const list = async () => ({}); list.viewer = async () => 'alice';
  const server = createApp({ list, savedViews: store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const damaged of ['broken JSON', 'null', '{"version":2,"accounts":[]}']) {
    await writeFile(path, damaged);
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${origin}/api/saved-views`, {
        method, headers: { 'Content-Type': 'application/json', Origin: origin },
        ...(method === 'POST' ? { body: JSON.stringify({ action: 'save', account: 'alice', name: 'New', query: 'is:open' }) } : {}),
      });
      assert.equal(response.status, 500);
      const { error } = await response.json();
      assert.match(error, /Cannot read the saved-views config file/);
      assert.match(error, /repair or restore it from a backup, then retry/);
      assert.match(error, /file has not been changed/);
      assert.equal(await readFile(path, 'utf8'), damaged);
    }
  }
  await writeFile(path, original);
  const response = await fetch(`${origin}/api/saved-views`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).views[0].name, 'Mine');
  await store.change('alice', { action: 'save', name: 'New', query: 'is:open' });
  assert.equal((await store.list('alice')).length, 2);
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
