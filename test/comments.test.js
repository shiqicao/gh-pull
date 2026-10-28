import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, validateComment } from '../github.js';
import { createApp } from '../server.js';

test('quick comments validate content and IDs', () => {
  assert.deepEqual(validateComment({ id: 'PR_1', body: '  **Thanks**\nLooks good.  ' }), { id: 'PR_1', body: '**Thanks**\nLooks good.' });
  for (const body of ['', '  ', null, 'x'.repeat(4001)]) assert.throws(() => validateComment({ id: 'PR_1', body }));
  assert.throws(() => validateComment({ id: '', body: 'Thanks' }));
});

test('quick comments verify PR identity and post once without a follow-up read', async () => {
  for (const node of [{ __typename: 'Issue' }, { __typename: 'PullRequest' }]) {
    const calls = [];
    const api = createGitHub({ getToken: async () => 'mock', fetchImpl: async (_url, options) => {
      const input = JSON.parse(options.body); calls.push(input);
      if (calls.length === 1) { assert.doesNotMatch(input.query, /viewerCanComment/); return Response.json({ data: { node } }); }
      return Response.json({ data: { addComment: { commentEdge: { node: { id: 'C_1', url: 'https://github.com/example/repo/pull/1#issuecomment-1' } }, subject: { id: 'PR_1', updatedAt: '2026-10-28', totalCommentsCount: 5 } } } });
    } });
    if (node.__typename !== 'PullRequest') { await assert.rejects(api.addComment({ id: 'PR_1', body: 'Thanks' })); assert.equal(calls.length, 1); }
    else {
      const result = await api.addComment({ id: 'PR_1', body: 'Thanks' });
      assert.equal(result.commentCount, 5); assert.equal(calls.length, 2);
      assert.deepEqual(calls[1].variables.input, { subjectId: 'PR_1', body: 'Thanks' });
    }
  }
});

test('comment endpoint requires same origin and JSON, supports Unicode, and never retries', async t => {
  let count = 0;
  const list = async () => ({ items: [] });
  list.addComment = async input => { count++; assert.equal(input.body, '谢谢'.repeat(2000)); return { id: input.id, commentCount: 1 }; };
  const server = createApp({ list });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/api/pulls/comment`;
  const options = { method: 'PATCH', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'PR_1', body: '谢谢'.repeat(2000) }) };
  assert.equal((await fetch(url, { ...options, headers: { ...options.headers, origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(url, { ...options, headers: { origin, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await fetch(url, options)).status, 200); assert.equal(count, 1);
});

test('comment preflight failures do not post or warn of duplicates; mutation failures are not retried', async () => {
  for (const failOn of [1, 2]) {
    let calls = 0;
    const api = createGitHub({ getToken: async () => 'mock', fetchImpl: async () => {
      calls++;
      if (calls === failOn) return Response.json({ errors: [{ message: 'GitHub rejected this request' }] });
      return Response.json({ data: { node: { __typename: 'PullRequest', id: 'PR_1' } } });
    } });
    await assert.rejects(api.addComment({ id: 'PR_1', body: 'Thanks' }), error => {
      assert.equal(/duplicate comment/.test(error.message), failOn === 2);
      return true;
    });
    assert.equal(calls, failOn);
  }
});
