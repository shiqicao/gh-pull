import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, mergeOptions } from '../github.js';
import { createApp } from '../server.js';

const headOid = 'a'.repeat(40);
const ready = {
  __typename: 'PullRequest', id: 'PR_1', state: 'OPEN', isDraft: false,
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
    return Response.json({ data: calls.length === 1 ? { node: pr } : { mergePullRequest: { pullRequest: result } } });
  } });
  return { github, calls };
}

test('merge readiness excludes blocked, draft, queued, stacked and unauthorized PRs', () => {
  assert.equal(mergeOptions(ready).canMerge, true);
  for (const overrides of [
    { state: 'MERGED' }, { isDraft: true }, { mergeable: 'CONFLICTING' }, { mergeable: 'UNKNOWN' },
    ...['BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', 'UNKNOWN', 'UNSTABLE'].map(mergeStateStatus => ({ mergeStateStatus })),
    { reviewDecision: 'REVIEW_REQUIRED' }, { reviewDecision: 'CHANGES_REQUESTED' },
    { mergeQueue: { id: 'q' } }, { stackEntry: { id: 's' } },
    { repository: { ...ready.repository, viewerPermission: 'READ' } },
    { repository: { viewerPermission: 'ADMIN' } },
    { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } },
  ]) assert.equal(mergeOptions({ ...ready, ...overrides }).canMerge, false, JSON.stringify(overrides));
  assert.equal(mergeOptions({ ...ready, repository: { ...ready.repository, squashMergeAllowed: false } }).mergeMethod, 'MERGE');
});

test('merge rechecks GitHub and pins mutation to displayed head and method', async () => {
  const { github, calls } = client();
  assert.equal((await github.merge(input)).status, 'MERGED');
  assert.deepEqual(calls[1].variables.input, { pullRequestId: ready.id, expectedHeadOid: headOid, mergeMethod: 'SQUASH' });
  assert.match(calls[0].query, /mergeStateStatus/);
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
