import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../github.js';
import { validateReviewerChange } from '../reviewer-management.js';
const base = { __typename: 'PullRequest', id: 'P1', number: 1, state: 'OPEN', isDraft: false, author: { login: 'alice' }, repository: { nameWithOwner: 'org/repo' }, commits: { nodes: [] }, labels: { nodes: [] } };
function fixture({ pr = base, requests = { users: [], teams: [] }, fail = false, missing = false, contributors = [], contributorStatus = 404 } = {}) {
  const calls = [];
  const list = createGitHub({ getToken: async () => 'mock', fetchImpl: async (url, options) => {
    const body = options.body && JSON.parse(options.body); calls.push({ url, method: options.method, body });
    if (url.endsWith('/graphql')) return Response.json({ data: { viewer: { login: 'alice' }, node: { ...pr, suggestedReviewerActors: { pageInfo: { hasNextPage: true }, nodes: [{ reviewer: { id: 'U1', login: 'alice' } }, { reviewer: { id: 'U2', login: 'bob', name: 'Bob' } }] } } } });
    if (url.includes('/contributors?')) return contributors === null ? Response.json({ message: 'Unavailable' }, { status: contributorStatus }) : Response.json(contributors);
    if (missing) return Response.json({ message: 'Not Found' }, { status: 404 });
    if (options.method === 'GET') return Response.json(requests);
    return fail ? Response.json({}, { status: 422 }) : Response.json({});
  } });
  return { list, calls };
}
test('reviewer search filters author and reports truncated suggestions', async () => {
  const { list } = fixture();
  assert.deepEqual(await list.reviewerSuggestions('P1', 'bo'), { reviewers: [{ name: 'bob', displayName: 'Bob', kind: 'user' }], limited: true });
});
test('request, re-request and removal only target selected user or team', async () => {
  for (const kind of ['user', 'team']) for (const action of ['request', 'remove']) {
    const { list, calls } = fixture({ requests: action === 'remove' ? { users: [{ login: 'bob' }, { login: 'carol' }], teams: [{ slug: 'core' }, { slug: 'infra' }] } : undefined });
    await list.changeReviewer({ id: 'P1', kind, name: kind === 'team' ? 'org/core' : 'bob', action });
    const mutation = calls.find(c => ['DELETE', 'POST'].includes(c.method) && !c.url.endsWith('/graphql'));
    assert.equal(mutation.method, action === 'request' ? 'POST' : 'DELETE');
    assert.deepEqual(mutation.body, kind === 'team' ? { team_reviewers: ['core'] } : { reviewers: ['bob'] });
  }
});
test('retrying a confirmed request or removed request sends no mutation', async () => {
  for (const action of ['request', 'remove']) {
    const { list, calls } = fixture({ requests: { users: action === 'request' ? [{ login: 'BOB' }] : [], teams: [] } });
    await list.changeReviewer({ id: 'P1', kind: 'user', name: 'bob', action });
    assert.equal(calls.filter(c => !c.url.endsWith('/graphql') && c.method !== 'GET').length, 0);
  }
});
test('reject ownership, lifecycle, author and foreign teams before mutation', async () => {
  for (const pr of [{ ...base, author: { login: 'other' } }, { ...base, state: 'MERGED' }, { ...base, isDraft: true }]) {
    const { list, calls } = fixture({ pr });
    await assert.rejects(list.changeReviewer({ id: 'P1', kind: 'user', name: 'bob', action: 'request' }));
    assert.equal(calls.length, 1);
  }
  for (const [kind, name] of [['user', 'alice'], ['team', 'other/core']]) {
    const { list, calls } = fixture();
    await assert.rejects(list.changeReviewer({ id: 'P1', kind, name, action: 'request' })); assert.equal(calls.length, 1);
  }
});
test('invalid input and GitHub eligibility errors are actionable', async () => {
  for (const change of [null, {}, { id: 'P1', kind: 'user', name: 'org/team', action: 'request' }, { id: 'P1', kind: 'team', name: 'foo', action: 'remove' }]) assert.throws(() => validateReviewerChange(change));
  await assert.rejects(fixture({ fail: true }).list.changeReviewer({ id: 'P1', kind: 'user', name: 'bob', action: 'request' }), /eligibility/);
});

test('reviewer HTTP mutation enforces same-origin and validates input', async t => {
  const { createApp } = await import('../server.js');
  let calls = 0;
  const list = async () => ({});
  list.changeReviewer = async input => { calls++; return { id: input.id }; };
  const server = createApp({ list });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/api/pulls/reviewers`;
  const body = JSON.stringify({ id: 'P1', action: 'request', kind: 'user', name: 'bob' });
  assert.equal((await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: origin }, body })).status, 200);
  assert.equal(calls, 1);
});


test('reviewer errors distinguish removal failures and inaccessible repositories', async () => {
  await assert.rejects(fixture({ fail: true, requests: { users: [{ login: 'bob' }], teams: [] } }).list.changeReviewer({ id: 'P1', kind: 'user', name: 'bob', action: 'remove' }), error => error.status === 422 && /could not remove/.test(error.message));
  await assert.rejects(fixture({ missing: true }).list.changeReviewer({ id: 'P1', kind: 'user', name: 'bob', action: 'request' }), error => error.status === 404 && /repository access and token permissions/.test(error.message));
});

test('shared transport keeps validation errors generic and preserves GitHub messages', async () => {
  const { createGitHubTransport } = await import('../github-client.js');
  for (const status of [404, 422]) {
    const request = createGitHubTransport({ getToken: async () => 'mock', fetchImpl: async () => Response.json({ message: 'Generic failure' }, { status }) });
    await assert.rejects(request('/unrelated'), error => error.status === status && error.message === 'GitHub: Generic failure');
  }
  const request = createGitHubTransport({ getToken: async () => 'mock', fetchImpl: async () => new Response('', { status: 422 }) });
  await assert.rejects(request('/unrelated'), error => error.status === 422 && error.message === 'GitHub returned HTTP 422.');
});


test('empty reviewer search lists human contributors, excluding author, and caches per repository', async () => {
  const { list, calls } = fixture({ contributors: [
    { login: 'alice', type: 'User' }, { login: 'dana', type: 'User' },
    { login: 'robot', type: 'Bot' }, { name: 'Anonymous', type: 'Anonymous' },
  ] });
  assert.deepEqual(await list.reviewerSuggestions('P1'), { reviewers: [{ name: 'bob', displayName: 'Bob', kind: 'user' }, { name: 'dana', displayName: 'Repository contributor', kind: 'user' }], limited: true });
  assert.equal(calls.filter(c => c.body?.query?.includes('ReviewerSuggestions')).length, 1);
  const filtered = await list.reviewerSuggestions('P1', 'da');
  assert.equal(filtered.reviewers[1].name, 'dana');
  await list.reviewerSuggestions('P1');
  assert.equal(calls.filter(c => c.url.includes('/contributors?')).length, 1);
});

test('contributor and GitHub search results deduplicate logins and flag capped lists', async () => {
  const { list } = fixture({ contributors: Array.from({ length: 100 }, (_, i) => ({ login: i ? `person${i}` : 'BOB', type: 'User' })) });
  const results = await list.reviewerSuggestions('P1', 'bo');
  assert.equal(results.reviewers.length, 1);
  assert.equal(results.reviewers[0].name, 'bob');
  assert.equal(results.limited, true);
});


test('unavailable contributors do not block typed reviewer search', async () => {
  const { list } = fixture({ contributors: null });
  assert.equal((await list.reviewerSuggestions('P1')).reviewers[0].name, 'bob');
  assert.equal((await list.reviewerSuggestions('P1', 'bob')).reviewers[0].name, 'bob');
});


test('large-repository contributor failures fall back on empty query and cache the failure', async () => {
  const { list, calls } = fixture({ contributors: null, contributorStatus: 403 });
  for (let i = 0; i < 2; i++) assert.equal((await list.reviewerSuggestions('P1')).reviewers[0].name, 'bob');
  assert.equal(calls.filter(c => c.url.includes('/contributors?')).length, 1);
});
