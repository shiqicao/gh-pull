import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewThreadCounts } from '../review-thread-counts.js';
const pr = { id: 'one', commentCount: 102, updatedAt: '2026-10-20T00:00:00Z' };
const response = (nodes, totalCount = nodes.length, cursor = null) => ({ node: { reviewThreads: {
  nodes: nodes.map(isResolved => ({ isResolved })), totalCount, pageInfo: { hasNextPage: Boolean(cursor), endCursor: cursor },
} } });
test('thread counts paginate exactly and cache across polls, invalidating on time or PR update', async () => {
  let calls = 0, time = 0;
  const load = createReviewThreadCounts(async (query, { cursor }) => { calls++; return cursor ? response([false, true], 102) : response(Array(100).fill(true), 102, 'next'); }, { now: () => time });
  assert.deepEqual((await load([pr]))[0].reviewThreadCounts, { resolved: 101, total: 102 });
  await load([pr]); assert.equal(calls, 2);
  time = 60_001; await load([pr]); assert.equal(calls, 4);
  await load([{ ...pr, updatedAt: 'new' }]); assert.equal(calls, 6);
});
test('lookups skip empty PRs, share in-flight work and bound per-batch concurrency', async () => {
  let active = 0, peak = 0, calls = 0;
  const load = createReviewThreadCounts(async () => { calls++; peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return response([true]); });
  await Promise.all([load([pr]), load([pr])]); assert.equal(calls, 1);
  const items = await load(Array.from({ length: 12 }, (_, i) => ({ ...pr, id: String(i) })));
  assert.equal(items.length, 12); assert.ok(peak <= 4);
  await load([{ ...pr, id: 'empty', commentCount: 0 }]); assert.equal(calls, 13);
});
test('partial, failed, inconsistent and runaway lookups fall back instead of showing wrong totals', async () => {
  for (const query of [async () => { throw Error('offline'); }, async () => response([true], 3), async () => response([true], 3, 'same')]) {
    assert.equal((await createReviewThreadCounts(query)([pr]))[0].reviewThreadCounts, null);
  }
  let calls = 0;
  const result = await createReviewThreadCounts(async () => response(Array(100).fill(true), 1001, String(++calls)))([pr]);
  assert.equal(calls, 10); assert.equal(result[0].reviewThreadCounts, null);
});

test('main list and status never fetch review threads; dedicated lookup uses lightweight versions', async () => {
  const { createGitHub } = await import('../github.js');
  const calls = [];
  const node = { id: 'one', updatedAt: pr.updatedAt, totalCommentsCount: 4, state: 'OPEN', author: { login: 'alice' }, repository: { nameWithOwner: 'team/repo' }, labels: { nodes: [] }, commits: { nodes: [] } };
  const list = createGitHub({ getToken: async () => 'mock', fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body); calls.push(request.query);
    if (request.query.includes('query ReviewThreadCounts')) return Response.json({ data: response([true, false]) });
    if (request.query.includes('query ReviewCountVersions')) return Response.json({ data: { nodes: [node] } });
    return Response.json({ data: { viewer: { login: 'alice', pullRequests: { totalCount: 1, nodes: [node], pageInfo: { hasNextPage: false } } }, nodes: [node] } });
  } });
  await list(); await list.status(['one']);
  assert.equal(calls.length, 2); assert.ok(calls.every(query => !query.includes('reviewThreads')));
  const result = await list.reviewCounts(['one']);
  assert.deepEqual(result.items[0].reviewThreadCounts, { resolved: 1, total: 2 });
  assert.doesNotMatch(calls[2], /commits|latestReviews|mergeable/);
});
