import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewCountsLoader } from '../public/review-counts.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const pr = { id: 'one', updatedAt: 'v1', commentCount: 3 };
test('count loading is background, bounded, cached and rejects stale versions/accounts', async () => {
  const requests = [], updates = []; let time = 0;
  const loader = createReviewCountsLoader({ now: () => time, onCounts: (...args) => updates.push(args),
    fetchCounts: (id, signal) => new Promise(resolve => requests.push({ id, signal, resolve })) });
  loader.update(Array.from({ length: 6 }, (_, i) => ({ ...pr, id: String(i) })), 'alice');
  await tick(); assert.equal(requests.length, 4); assert.equal(updates.length, 0);
  loader.update([{ ...pr, id: '0', updatedAt: 'v2' }], 'bob');
  for (const r of requests) r.resolve({ items: [{ id: r.id, updatedAt: 'v1', reviewThreadCounts: { resolved: 1, total: 2 } }] });
  await tick(); assert.equal(updates.length, 0); assert.equal(requests.length, 5);
  requests[4].resolve({ items: [{ id: '0', updatedAt: 'v2', reviewThreadCounts: { resolved: 2, total: 2 } }] });
  await tick(); assert.deepEqual(updates, [['0', 'v2', { resolved: 2, total: 2 }]]);
  loader.update([{ ...pr, id: '0', updatedAt: 'v2' }], 'bob'); await tick(); assert.equal(requests.length, 5);
  time = 60001; loader.update([{ ...pr, id: '0', updatedAt: 'v2' }], 'bob'); await tick(); assert.equal(requests.length, 6);
  loader.clear(); requests[5].resolve({ items: [] }); await tick(); assert.equal(requests[5].signal.aborted, true);
});
test('failed lookups use a backoff and mismatched versions never apply counts', async () => {
  let calls = 0; const updates = [];
  const loader = createReviewCountsLoader({ fetchCounts: async () => { calls++; throw Error('offline'); }, onCounts: (...args) => updates.push(args) });
  loader.update([pr], 'alice'); await tick(); assert.deepEqual(updates[0], ['one', 'v1', null]);
  loader.update([pr], 'alice'); await tick(); assert.equal(calls, 1);
  const other = createReviewCountsLoader({ fetchCounts: async () => ({ items: [{ ...pr, updatedAt: 'old', reviewThreadCounts: { resolved: 1, total: 1 } }] }), onCounts: (...args) => updates.push(args) });
  other.update([pr], 'alice'); await tick(); assert.equal(updates.at(-1)[2], null);
});
