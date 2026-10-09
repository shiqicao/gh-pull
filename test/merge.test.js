import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, mergeOptions } from '../github.js';
import { createApp } from '../server.js';

const headOid = 'a'.repeat(40);
const ready = {
  author: { login: 'Alice' }, __typename: 'PullRequest', id: 'PR_1', state: 'OPEN', isDraft: false,
  headRefOid: headOid, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED', mergeQueue: null, stackEntry: null,
  repository: { viewerPermission: 'WRITE', viewerDefaultMergeMethod: 'SQUASH', squashMergeAllowed: true, mergeCommitAllowed: true },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
};
const input = { id: ready.id, headOid, mergeMethod: 'SQUASH' };
function client(pr = ready, result = { id: ready.id, state: 'MERGED', updatedAt: '2026-10-08T00:00:00Z' }) {
  const calls = [];
  const github = createGitHub({ getToken: async () => 'mock', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return Response.json({ data: calls.length === 1 ? { node: pr, viewer: { login: 'alice' } } : { mergePullRequest: { pullRequest: result } } });
  } });
  return { github, calls };
}

test('merge readiness excludes blocked, draft, queued, stacked and unauthorized PRs', () => {
  assert.equal(mergeOptions(ready, 'alice').canMerge, true);
  for (const overrides of [
    { state: 'MERGED' }, { isDraft: true }, { mergeable: 'CONFLICTING' }, { mergeable: 'UNKNOWN' },
    ...['BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', 'UNKNOWN', 'UNSTABLE'].map(mergeStateStatus => ({ mergeStateStatus })),
    { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }, { reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' },
    { mergeQueue: { id: 'q' } }, { stackEntry: { id: 's' } },
    { repository: { ...ready.repository, viewerPermission: 'READ' } },
    { repository: { viewerPermission: 'ADMIN' } },
    { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } },
  ]) assert.equal(mergeOptions({ ...ready, ...overrides }, 'alice').canMerge, false, JSON.stringify(overrides));
  assert.equal(mergeOptions({ ...ready, repository: { ...ready.repository, squashMergeAllowed: false } }, 'alice').mergeMethod, 'MERGE');
});

test('merge rechecks GitHub and pins mutation to displayed head and method', async () => {
  const { github, calls } = client();
  assert.equal((await github.merge(input)).status, 'MERGED');
  assert.deepEqual(calls[1].variables.input, { pullRequestId: ready.id, expectedHeadOid: headOid, mergeMethod: 'SQUASH' });
  assert.match(calls[0].query, /mergeStateStatus/);
});

test('nonblocking review decisions do not override GitHub’s clean merge status', async () => {
  for (const reviewDecision of ['REVIEW_REQUIRED', 'CHANGES_REQUESTED']) {
    for (const mergeStateStatus of ['CLEAN', 'HAS_HOOKS']) {
      const pr = { ...ready, reviewDecision, mergeStateStatus };
      assert.equal(mergeOptions(pr, 'alice').canMerge, true);
      const { github, calls } = client(pr);
      assert.equal((await github.merge(input)).status, 'MERGED');
      assert.equal(calls[1].variables.input.expectedHeadOid, headOid);
    }
    const { github, calls } = client({ ...ready, reviewDecision, mergeStateStatus: 'BLOCKED' });
    await assert.rejects(github.merge(input), { status: 409 });
    assert.equal(calls.length, 1);
  }
});

test('merge rejects changed commits, stale readiness, changed method and malformed input without mutation', async () => {
  for (const overrides of [{ headRefOid: 'b'.repeat(40) }, { mergeStateStatus: 'BLOCKED' }, { repository: { ...ready.repository, viewerDefaultMergeMethod: 'MERGE' } }]) {
    const { github, calls } = client({ ...ready, ...overrides });
    await assert.rejects(github.merge(input), { status: 409 });
    assert.equal(calls.length, 1);
  }
  const { github, calls } = client();
  await assert.rejects(github.merge({ ...input, headOid: '' }), { status: 400 });
  assert.equal(calls.length, 0);
  await assert.rejects(client(ready, { state: 'OPEN' }).github.merge(input), /did not confirm/);
});

test('merge endpoint requires same origin and JSON, validates input and clears cache after success', async t => {
  let lists = 0, merges = 0;
  const app = createApp({ list: async () => ({ count: ++lists }), merge: async value => {
    assert.deepEqual(value, input); merges++; return { id: value.id, status: 'MERGED' };
  } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const patch = headers => fetch(`${origin}/api/pulls/merge`, { method: 'PATCH', headers, body: JSON.stringify(input) });
  await fetch(`${origin}/api/pulls`);
  assert.equal((await patch({ 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await patch({ Origin: origin })).status, 415);
  assert.equal(merges, 0);
  assert.equal((await patch({ Origin: origin, 'Content-Type': 'application/json' })).status, 200);
  await fetch(`${origin}/api/pulls`);
  assert.equal(lists, 2);
  assert.equal(merges, 1);
});


test('merge is limited to the authenticated author, including missing authors', async () => {
  for (const author of [{ login: 'bob' }, null]) {
    const pr = { ...ready, author };
    assert.equal(mergeOptions(pr, 'alice').canMerge, false);
    const { github, calls } = client(pr);
    await assert.rejects(github.merge(input), { status: 403 });
    assert.equal(calls.length, 1);
  }
  assert.equal(mergeOptions(ready).canMerge, false);
});

test('unknown mergeability is flagged for retry only for the viewer’s eligible open PRs', () => {
  const unknown = { ...ready, mergeable: 'UNKNOWN' };
  assert.equal(mergeOptions(unknown, 'alice').mergePending, true);
  assert.equal(mergeOptions(unknown, 'alice').canMerge, false);
  assert.equal(mergeOptions({ ...ready, mergeStateStatus: 'UNKNOWN' }, 'alice').mergePending, true);
  assert.equal(mergeOptions(ready, 'alice').mergePending, false);
  for (const overrides of [
    { isDraft: true }, { state: 'CLOSED' }, { author: { login: 'bob' } },
    { mergeQueue: { id: 'queue' } }, { stackEntry: { id: 'stack' } },
    { repository: { ...ready.repository, viewerPermission: 'READ' } },
  ]) assert.equal(mergeOptions({ ...unknown, ...overrides }, 'alice').mergePending, false);
});

test('merge readiness reads current GitHub state and keeps commit pinning and ownership restrictions', async () => {
  let count = 0;
  const list = createGitHub({ getToken: async () => 'mock', fetchImpl: async (url, options) => {
    const { query, variables } = JSON.parse(options.body);
    assert.deepEqual(variables.ids, ['PR_1', 'PR_2']);
    assert.match(query, /nodes\(ids: \$ids\)/);
    count++;
    return Response.json({ data: { viewer: { login: 'alice' }, nodes: [
      { ...ready, mergeable: count === 1 ? 'UNKNOWN' : 'MERGEABLE' },
      { ...ready, id: 'PR_2', author: { login: 'bob' } }, null,
    ] } });
  } });
  const first = await list.mergeReadiness(['PR_1', 'PR_2']);
  assert.equal(first.items[0].mergePending, true);
  assert.equal(first.items[0].canMerge, false);
  const second = await list.mergeReadiness(['PR_1', 'PR_2']);
  assert.equal(second.items[0].canMerge, true);
  assert.equal(second.items[0].headOid, headOid);
  assert.equal(second.items[1].canMerge, false);
  assert.equal(second.items.length, 2);
});

test('readiness endpoint validates IDs and bypasses the PR list cache', async t => {
  let calls = 0;
  const list = async () => ({ items: [] });
  list.mergeReadiness = async ids => { calls++; return { items: ids.map(id => ({ id, ...mergeOptions(ready, 'alice') })) }; };
  const app = createApp({ list });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}/api/pulls/readiness`;
  for (const query of ['', '?id=', '?id=' + 'x'.repeat(201), '?' + Array(51).fill('id=PR_1').join('&')]) {
    assert.equal((await fetch(base + query)).status, 400);
  }
  assert.equal(calls, 0);
  for (let n = 0; n < 2; n++) {
    const result = await fetch(base + '?id=PR_1');
    assert.equal(result.status, 200);
    assert.equal((await result.json()).items[0].canMerge, true);
  }
  assert.equal(calls, 2);
  assert.equal((await fetch(base + '?id=PR_1', { headers: { Origin: 'https://evil.example' } })).status, 403);
});
