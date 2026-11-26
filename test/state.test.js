import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewedStore, createLatestRequest, mergePullPages } from '../public/state.js';

const pr = (hour, id = 'one') => ({ id, updatedAt: `2026-01-01T${String(hour).padStart(2, '0')}:00:00Z` });
function memoryStorage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('read history is account-scoped and marks confirmed versions without hiding newer updates', () => {
  const storage = memoryStorage(), store = createViewedStore(storage);
  assert.equal(store.mark(pr(1)), false);
  assert.equal(store.selectAccount('Alice'), true);
  assert.equal(store.hasUpdates(pr(1)), true);
  store.mark(pr(2)); store.mark(pr(1));
  assert.equal(store.hasUpdates(pr(2)), false);
  assert.equal(store.hasUpdates(pr(3)), true);
  assert.equal(store.selectAccount('ALICE'), false);
  store.selectAccount('bob'); assert.equal(store.hasUpdates(pr(2)), true);
  store.selectAccount('alice'); assert.equal(store.hasUpdates(pr(2)), false);
  const reloaded = createViewedStore(storage); reloaded.selectAccount('alice');
  assert.equal(reloaded.hasUpdates(pr(2)), false);
});

test('commit baselines support old timestamp entries, newer heads and rewrites', () => {
  const storage = memoryStorage(), store = createViewedStore(storage);
  storage.setItem('gh-pull.viewed.v1:alice', JSON.stringify({ one: Date.parse(pr(1).updatedAt) }));
  store.selectAccount('alice');
  const first = { ...pr(1), headOid: 'a', commitCount: 2 };
  assert.equal(store.commitChange(first), null);
  store.mark(first);
  const changed = { ...pr(2), headOid: 'b', commitCount: 5 };
  const tab = createViewedStore(storage); tab.selectAccount('alice');
  assert.equal(tab.commitChange(changed), 3);
  assert.equal(tab.commitChange({ ...changed, commitCount: 2 }), 0);
  tab.mark(changed); tab.mark(first);
  assert.equal(tab.commitChange(changed), null);
});

test('storage failures and malformed data retain session-only read history', () => {
  const store = createViewedStore({ getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Quota'); } });
  store.selectAccount('alice'); store.mark(pr(2)); store.selectAccount('alice');
  assert.equal(store.hasUpdates(pr(2)), false);
  assert.equal(store.mark({ id: 'one', updatedAt: 'invalid' }), false);
  const storage = memoryStorage(); storage.setItem('gh-pull.viewed.v1:alice', '{broken');
  const fresh = createViewedStore(storage); fresh.selectAccount('alice');
  assert.equal(fresh.hasUpdates(pr(1)), true);
});

test('read history merges other tabs on writes, resists stale storage on refresh, and honors explicit clears', () => {
  const storage = memoryStorage(), a = createViewedStore(storage), b = createViewedStore(storage);
  a.selectAccount('alice'); b.selectAccount('alice');
  a.mark(pr(2)); b.mark(pr(1, 'two'));
  assert.equal(a.storageChanged('unrelated'), false);
  a.storageChanged('gh-pull.viewed.v1:alice');
  assert.equal(a.hasUpdates(pr(2)), false);
  assert.equal(a.hasUpdates(pr(1, 'two')), false);
  storage.setItem('gh-pull.viewed.v1:alice', JSON.stringify({ one: Date.parse(pr(1).updatedAt) }));
  a.selectAccount('alice'); assert.equal(a.hasUpdates(pr(2)), false);
  storage.data.clear(); a.storageChanged(null);
  assert.equal(a.hasUpdates(pr(2)), true);
});

test('latest request cancels superseded work and rejects late responses after cancellation', () => {
  const requests = createLatestRequest();
  const first = requests.start(), second = requests.start();
  assert.equal(first.signal.aborted, true);
  assert.equal(requests.isCurrent(first), false);
  assert.equal(requests.isCurrent(second), true);
  const revision = requests.revision;
  requests.cancel();
  assert.equal(second.signal.aborted, true);
  assert.equal(requests.isCurrent(second), false);
  assert.ok(requests.revision > revision);
  assert.equal(requests.isCurrent(requests.start()), true);
});

test('pagination deduplicates by PR ID, replaces updated records, and resets on refresh', () => {
  const previous = [pr(1), pr(1, 'two')], incoming = [pr(2), pr(1, 'three')];
  assert.deepEqual(mergePullPages(previous, incoming, true), [pr(2), pr(1, 'two'), pr(1, 'three')]);
  assert.deepEqual(mergePullPages(previous, incoming, false), incoming);
  assert.deepEqual(previous, [pr(1), pr(1, 'two')]);
});

test('confirmed merges survive removal and stale responses until the account changes', async () => {
  const { createMergedStore } = await import('../public/state.js');
  const store = createMergedStore();
  const open = { ...pr(1), status: 'OPEN', canMerge: true };
  assert.deepEqual(store.reconcile(open), open);
  store.reconcile({ ...pr(2), status: 'MERGED' });
  assert.equal(store.reconcile(open).status, 'MERGED');
  assert.equal(store.reconcile(open).canMerge, false);
  assert.equal(store.reconcile(open).updatedAt, pr(2).updatedAt);
  assert.equal(store.reconcile({ ...open, updatedAt: pr(3).updatedAt }).updatedAt, pr(3).updatedAt);
  store.clear();
  assert.deepEqual(store.reconcile(open), open);
});
