import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, validateReviewDismissal } from '../github.js';
import { reviewersFor } from '../pull-request.js';
const input = { id: 'PR_1', reviewId: 'R_1', message: 'Needs another look' };
const review = { id: 'R_1', state: 'APPROVED', author: { login: 'Alice' }, pullRequest: { id: 'PR_1', state: 'OPEN' } };
function client(node = review) {
  const calls = [];
  const pr = { id: 'PR_1', state: 'OPEN', author: { login: 'bob' }, repository: { nameWithOwner: 'team/repo' }, commits: { nodes: [] }, labels: { nodes: [] }, latestReviews: { pageInfo: { hasNextPage: false }, nodes: [{ ...review, state: 'DISMISSED' }] } };
  const github = createGitHub({ getToken: async () => 'mock', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return Response.json({ data: calls.length === 1 ? { node, viewer: { login: 'alice' } } : { dismissPullRequestReview: { pullRequestReview: { state: 'DISMISSED', pullRequest: pr } } } });
  } });
  return { github, calls };
}
test('revocation targets the displayed own approval and returns refreshed state', async () => {
  const { github, calls } = client();
  const result = await github.dismissReview(input);
  assert.equal(result.reviewers[0].state, 'DISMISSED');
  assert.equal(result.reviewers[0].canRevoke, false);
  assert.deepEqual(calls[1].variables.input, { pullRequestReviewId: 'R_1', message: input.message });
});
test('revocation rejects other reviewers, wrong PRs and stale approvals before mutation', async () => {
  for (const node of [null, { ...review, author: { login: 'bob' } }, { ...review, pullRequest: { id: 'other', state: 'OPEN' } }, { ...review, state: 'DISMISSED' }, { ...review, pullRequest: { id: 'PR_1', state: 'MERGED' } }]) {
    const { github, calls } = client(node);
    await assert.rejects(github.dismissReview(input)); assert.equal(calls.length, 1);
  }
  for (const message of ['', '   ', 'a'.repeat(1001)]) assert.throws(() => validateReviewDismissal({ ...input, message }));
});
test('revoke affordance is scoped to own open approval with write access', () => {
  const pr = { state: 'OPEN', author: { login: 'bob' }, repository: { viewerPermission: 'WRITE' }, latestReviews: { nodes: [review] } };
  assert.equal(reviewersFor(pr, 'alice')[0].canRevoke, true);
  assert.equal(reviewersFor(pr, 'other')[0].canRevoke, false);
  assert.equal(reviewersFor({ ...pr, state: 'MERGED' }, 'alice')[0].canRevoke, false);
  assert.equal(reviewersFor({ ...pr, repository: { viewerPermission: 'READ' } }, 'alice')[0].canRevoke, false);
});
