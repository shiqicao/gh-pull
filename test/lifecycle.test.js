import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, validateClose } from '../github.js';
import { createMergedStore } from '../public/state.js';
const pr = { __typename: 'PullRequest', id: 'PR_1', state: 'OPEN', isDraft: false, viewerCanClose: true, viewerCanReopen: true,
  author: { login: 'alice' }, repository: { nameWithOwner: 'example/repo' }, commits: { nodes: [] }, labels: { nodes: [] }, updatedAt: '2026-10-20T01:00:00Z' };
function client(initial = pr, commentFails = false) {
  const calls = [];
  const api = createGitHub({ getToken: async () => 'mock', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (calls.length === 1) return Response.json({ data: { node: initial, viewer: { login: 'alice' } } });
    if (body.query.includes('AddCommentInput')) {
      if (commentFails) return Response.json({ errors: [{ message: 'Comment rejected' }] });
      return Response.json({ data: { addComment: { commentEdge: { node: { id: 'comment' } } } } });
    }
    const name = body.query.includes('ReopenPullRequestInput') ? 'reopenPullRequest' : 'closePullRequest';
    return Response.json({ data: { [name]: { pullRequest: { ...initial, state: name === 'closePullRequest' ? 'CLOSED' : 'OPEN' } } } });
  } });
  return { api, calls };
}
test('close and reopen verify ownership, state and permissions', async () => {
  for (const initial of [{ ...pr, author: { login: 'other' } }, { ...pr, state: 'MERGED' }, { ...pr, viewerCanClose: false }]) {
    const { api, calls } = client(initial); await assert.rejects(api.closePull({ id: pr.id })); assert.equal(calls.length, 1);
  }
  const closed = client(); assert.equal((await closed.api.closePull({ id: pr.id })).status, 'CLOSED');
  assert.deepEqual(closed.calls[1].variables.input, { pullRequestId: pr.id });
  const reopened = client({ ...pr, state: 'CLOSED', isDraft: true });
  assert.equal((await reopened.api.reopenPull({ id: pr.id })).status, 'DRAFT');
  const denied = client({ ...pr, state: 'CLOSED', viewerCanReopen: false }); await assert.rejects(denied.api.reopenPull({ id: pr.id }));
});
test('close comments are optional, posted after closing, and not duplicated on a closed retry', async () => {
  const ok = client(); await ok.api.closePull({ id: pr.id, comment: ' Done ' });
  assert.equal(ok.calls.length, 3); assert.deepEqual(ok.calls[2].variables.input, { subjectId: pr.id, body: 'Done' });
  const failed = client(pr, true); const result = await failed.api.closePull({ id: pr.id, comment: 'Done' });
  assert.equal(result.status, 'CLOSED'); assert.match(result.warning, /comment could not be confirmed/);
  const retry = client({ ...pr, state: 'CLOSED' });
  assert.match((await retry.api.closePull({ id: pr.id, comment: 'Done' })).warning, /already closed/); assert.equal(retry.calls.length, 1);
  assert.throws(() => validateClose({ id: pr.id, comment: 'x'.repeat(4001) }));
});
test('confirmed close/reopen states survive stale search but yield to newer GitHub state', () => {
  const store = createMergedStore(); const open = { id: pr.id, status: 'OPEN', updatedAt: pr.updatedAt };
  store.confirm({ ...open, status: 'CLOSED' });
  assert.equal(store.reconcile(open).status, 'CLOSED');
  assert.equal(store.reconcile({ id: 'child', dependencyParent: open }).dependencyParent.status, 'CLOSED');
  store.confirm({ ...open, updatedAt: '2026-10-20T02:00:00Z' });
  assert.equal(store.reconcile({ ...open, status: 'CLOSED' }).status, 'OPEN');
  assert.equal(store.reconcile({ ...open, status: 'CLOSED', updatedAt: '2026-10-20T03:00:00Z' }).status, 'CLOSED');
  store.clear(); assert.equal(store.reconcile(open).status, 'OPEN');
});
