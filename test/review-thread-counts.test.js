import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewThreadCounts } from '../review-thread-counts.js';
const pr = { id: 'one', commentCount: 102, updatedAt: '2026-10-20T00:00:00Z' };
const response = (nodes, totalCount = nodes.length, cursor = null) => ({ node: { author: { login: 'alice' }, reviewThreads: {
  nodes: nodes.map(isResolved => ({ isResolved, comments: { totalCount: 1, nodes: [{ author: { login: 'bob' } }] } })), totalCount, pageInfo: { hasNextPage: Boolean(cursor), endCursor: cursor },
} } });
test('thread counts paginate exactly and cache across polls, invalidating on time or PR update', async () => {
  let calls = 0, time = 0;
  const load = createReviewThreadCounts(async (query, { cursor }) => { calls++; return cursor ? response([false, true], 102) : response(Array(100).fill(true), 102, 'next'); }, { now: () => time });
  assert.deepEqual((await load([pr]))[0].reviewThreadCounts, { resolved: 101, unresolved: 1, total: 102 });
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
  assert.deepEqual(result.items[0].reviewThreadCounts, { resolved: 1, unresolved: 1, total: 2 });
  assert.doesNotMatch(calls[2], /commits|latestReviews|mergeable/);
});

test('unanswered author threads stay in total but are excluded from unresolved', async () => {
  const thread = (login, totalCount = 1, isResolved = false) => ({ isResolved,
    comments: { totalCount, nodes: [{ author: login ? { login } : null }] } });
  const data = { node: { author: { login: 'Alice' }, reviewThreads: {
    totalCount: 6, pageInfo: { hasNextPage: false }, nodes: [
      thread('alice'), thread('alice', 2), thread('bob'), thread(null),
      thread('alice', 1, true), thread('bob', 3, true),
    ],
  } } };
  const load = createReviewThreadCounts(async query => {
    assert.match(query, /comments\(first: 1\)/);
    assert.match(query, /author \{ login \}/);
    return data;
  });
  assert.deepEqual((await load([pr]))[0].reviewThreadCounts, { resolved: 2, unresolved: 3, total: 6 });
});

test('missing authors do not hide threads and incomplete comment metadata is unavailable', async () => {
  const data = response([false]);
  data.node.author = null;
  data.node.reviewThreads.nodes[0].comments.nodes[0].author = null;
  assert.deepEqual((await createReviewThreadCounts(async () => data)([pr]))[0].reviewThreadCounts,
    { resolved: 0, unresolved: 1, total: 1 });
  for (const comments of [undefined, { totalCount: 0, nodes: [] }, { totalCount: 1, nodes: [] }]) {
    data.node.reviewThreads.nodes[0].comments = comments;
    assert.equal((await createReviewThreadCounts(async () => data)([pr]))[0].reviewThreadCounts, null);
  }
});
