import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createApp } from '../server.js';
import { createGitHub, ApiError, reviewersFor, validateTitleUpdate } from '../github.js';
import { assignNameColors, NAME_COLOR_COUNT, groupPulls, relativeTime, normalizeViewedUpdates, hasUnviewedUpdate } from '../public/model.js';

test('update tracking compares the displayed PR version rather than the time it was opened', () => {
  const pr = { id: 'pr-one', updatedAt: '2026-10-08T12:00:00Z' };
  assert.equal(hasUnviewedUpdate(pr, {}), true);
  const viewed = { [pr.id]: Date.parse(pr.updatedAt) };
  assert.equal(hasUnviewedUpdate(pr, viewed), false);
  assert.equal(hasUnviewedUpdate({ ...pr, updatedAt: '2026-10-08T12:01:00Z' }, viewed), true);
  assert.equal(hasUnviewedUpdate({ ...pr, updatedAt: '2026-10-08T11:00:00Z' }, viewed), false);
  assert.equal(hasUnviewedUpdate({ ...pr, id: 'pr-two' }, viewed), true);
  assert.deepEqual(normalizeViewedUpdates(JSON.parse(JSON.stringify(viewed))), viewed);
});

test('viewed history ignores invalid stored timestamps', () => {
  assert.deepEqual(normalizeViewedUpdates(null), {});
  assert.deepEqual(normalizeViewedUpdates({ valid: 123, bad: 'yesterday', negative: -1, infinite: Infinity, missing: null }), { valid: 123 });
});

test('name colors are deterministic, case-insensitive, order-independent and evenly spaced', () => {
  const names = ['alice', 'bob', 'carol', 'dave'];
  const colors = assignNameColors(names);
  assert.deepEqual(assignNameColors(['DAVE', 'Bob', 'alice', 'carol', 'ALICE']), colors);
  const slots = Object.values(colors).sort((a, b) => a - b);
  const gaps = slots.map((slot, i) => (slots[(i + 1) % slots.length] - slot + NAME_COLOR_COUNT) % NAME_COLOR_COUNT);
  assert.deepEqual(gaps, [3, 3, 3, 3]);
});

test('name colors persist through new pages and filters without reassigning known people', () => {
  const initial = assignNameColors(['alice', 'bob']);
  const restored = JSON.parse(JSON.stringify(initial));
  const added = assignNameColors(['carol'], restored);
  assert.equal(added.alice, initial.alice);
  assert.equal(added.bob, initial.bob);
  const distance = (a, b) => Math.min(Math.abs(a - b), NAME_COLOR_COUNT - Math.abs(a - b));
  assert.equal(distance(added.carol, added.alice), 3);
  assert.equal(distance(added.carol, added.bob), 3);
  assert.deepEqual(assignNameColors(['alice'], added), added);
});

test('name colors use every palette slot before reuse and handle invalid saved entries', () => {
  let colors = assignNameColors([], { bad: -1, invalid: 100, nope: 'red', good: 2 });
  assert.deepEqual(Object.keys(colors), ['good']);
  for (let i = 0; i < 11; i++) colors = assignNameColors([`person${i}`], colors);
  assert.equal(new Set(Object.values(colors)).size, 12);
  colors = assignNameColors(Array.from({ length: 24 }, (_, i) => `new${i}`), colors);
  const counts = Array(NAME_COLOR_COUNT).fill(0);
  Object.values(colors).forEach(slot => counts[slot]++);
  assert.ok(counts.every(count => count === 3));
});

const pr = {
  id: 'one', title: 'Fix keyboard navigation', number: 12, repo: 'owner/app',
  author: 'alice', status: 'OPEN', checks: 'SUCCESS', labels: ['accessibility'],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z',
};
const other = { ...pr, id: 'two', number: 13, author: 'bob', repo: 'owner/tools',
  status: 'DRAFT', checks: 'PENDING', title: 'Add tool', labels: [],
  createdAt: '2026-01-15T00:00:00Z', updatedAt: '2026-01-16T00:00:00Z' };

test('searches metadata, groups by supported fields, and sorts without mutating input', () => {
  for (const search of ['KEYBOARD', 'alice', '#12', 'accessibility', 'owner/app']) {
    assert.equal(groupPulls([pr, other], { search }).count, 1);
  }
  for (const group of ['repo', 'author', 'status', 'checks']) {
    assert.equal(groupPulls([pr, other], { group }).groups.length, 2);
  }
  const items = [other, pr];
  assert.deepEqual(groupPulls(items, { group: 'none' }).groups[0][1], [pr, other]);
  assert.deepEqual(groupPulls(items, { group: 'none', sort: 'created' }).groups[0][1], [other, pr]);
  assert.deepEqual(groupPulls(items, { group: 'none', sort: 'oldest' }).groups[0][1], [pr, other]);
  assert.deepEqual(items, [other, pr]);
  assert.equal(groupPulls(items, { search: 'missing' }).count, 0);
});

test('relative time handles minute, hour, day and future dates', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  assert.equal(relativeTime('2026-01-01T00:00:00Z', now), '1d ago');
  assert.equal(relativeTime('2026-01-01T23:00:00Z', now), '1h ago');
  assert.equal(relativeTime('2026-01-01T23:59:00Z', now), '1m ago');
  assert.equal(relativeTime('2026-01-03T00:00:00Z', now), 'just now');
});

function node(overrides = {}) {
  return { ...pr, url: 'https://github.com/owner/app/pull/12', state: 'OPEN', isDraft: true,
    author: null, repository: { nameWithOwner: pr.repo }, headRefName: 'feature/keyboard-navigation', additions: 2, deletions: 1,
    reviewDecision: null, labels: { nodes: [{ name: 'accessibility' }] }, commits: { nodes: [] }, ...overrides };
}

test('reviewers combine submitted reviews and requests, with re-requests taking precedence', () => {
  assert.deepEqual(reviewersFor({}), []);
  const result = reviewersFor({
    author: { login: 'owner' },
    latestReviews: { nodes: [
      { author: { login: 'alice' }, state: 'APPROVED' },
      { author: { login: 'bob' }, state: 'CHANGES_REQUESTED' },
      { author: { login: 'owner' }, state: 'COMMENTED' },
      { author: null, state: 'COMMENTED' },
      { author: { login: 'draft-reviewer' }, state: 'PENDING' },
    ] },
    reviewRequests: { nodes: [
      { requestedReviewer: { login: 'alice' } },
      { requestedReviewer: { login: 'carol' } },
      { requestedReviewer: { slug: 'core', organization: { login: 'org' } } },
      { requestedReviewer: null },
    ] },
  });
  assert.deepEqual(result, [
    { name: 'alice', state: 'REQUESTED' },
    { name: 'bob', state: 'CHANGES_REQUESTED' },
    { name: 'carol', state: 'REQUESTED' },
    { name: 'org/core', state: 'REQUESTED' },
  ]);
});

test('authored history uses an unlimited connection, cursor, states and normalizes absent metadata', async () => {
  let request;
  const list = createGitHub({ getToken: async () => 'test-token', fetchImpl: async (url, options) => {
    request = JSON.parse(options.body);
    return Response.json({ data: { viewer: { login: 'alice', pullRequests: {
      totalCount: 1501, pageInfo: { hasNextPage: true, endCursor: 'next' }, nodes: [node()],
    } } } });
  } });
  const result = await list({ state: 'all', cursor: 'previous' });
  assert.match(request.query, /pullRequests/);
  assert.deepEqual(request.variables, { cursor: 'previous', states: ['OPEN', 'CLOSED', 'MERGED'] });
  assert.equal(result.total, 1501); assert.equal(result.limited, false);
  assert.equal(result.items[0].author, 'deleted-user');
  assert.equal(result.items[0].branch, 'feature/keyboard-navigation');
  assert.equal(result.items[0].status, 'DRAFT');
  assert.equal(result.items[0].checks, 'NONE');
  assert.equal(result.items[0].review, 'NONE');
  assert.equal(result.pageInfo.endCursor, 'next');
});

test('pending check counts include runs and commit statuses, counting only successful checks as passed', async () => {
  const list = createGitHub({ getToken: async () => 'test-token', fetchImpl: async () => Response.json({ data: {
    viewer: { login: 'alice', pullRequests: {
      totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node({
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: {
          totalCount: 8,
          checkRunCountsByState: [{ state: 'SUCCESS', count: 1 }, { state: 'IN_PROGRESS', count: 3 }, { state: 'SKIPPED', count: 1 }, { state: 'NEUTRAL', count: 1 }],
          statusContextCountsByState: [{ state: 'PENDING', count: 1 }, { state: 'FAILURE', count: 1 }],
        } } } }] },
      })],
    } },
  } }) });
  const result = await list();
  assert.equal(result.items[0].checks, 'PENDING');
  assert.deepEqual(result.items[0].checkCounts, { passed: 1, total: 8 });
});

test('search scopes are explicit and disclose GitHub search limits', async () => {
  let query;
  const list = createGitHub({ getToken: async () => 'test-token', fetchImpl: async (url, options) => {
    query = JSON.parse(options.body).variables.query;
    return Response.json({ data: { viewer: { login: 'alice' }, search: {
      issueCount: 1200, pageInfo: { hasNextPage: true, endCursor: 'next' }, nodes: [node({ state: 'MERGED' })],
    } } });
  } });
  assert.equal((await list({ scope: 'involved', state: 'merged' })).limited, true);
  assert.match(query, /involves:@me is:merged/);
  await list({ scope: 'review' }); assert.match(query, /review-requested:@me is:open/);
  await assert.rejects(list({ state: 'bogus' }), { status: 400 });
});

test('authentication failures discard the token and retry obtains a new credential', async () => {
  let tokens = 0;
  const list = createGitHub({ getToken: async () => `token-${++tokens}`, fetchImpl: async () => new Response('', { status: 401 }) });
  await assert.rejects(list(), { status: 401 });
  await assert.rejects(list(), { status: 401 });
  assert.equal(tokens, 2);
});

test('GitHub network, rate limit and GraphQL errors are actionable', async () => {
  for (const [fetchImpl, pattern] of [
    [async () => { throw new Error('network'); }, /connection/],
    [async () => new Response('', { status: 429 }), /rate limit/],
    [async () => Response.json({ errors: [{ message: 'Insufficient scope' }] }), /Insufficient scope/],
  ]) {
    await assert.rejects(createGitHub({ getToken: async () => 'test', fetchImpl })(), pattern);
  }
});

async function server(t, list, updateTitle, convertToDraft, markReadyForReview) {
  const app = createApp({ list, updateTitle, convertToDraft, markReadyForReview });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return `http://127.0.0.1:${app.address().port}`;
}

test('HTTP API caches pages, honors refresh and separates pagination/filter keys', async t => {
  const calls = [];
  const base = await server(t, async args => { calls.push(args); return { items: [], total: 0 }; });
  for (const path of ['/api/pulls', '/api/pulls', '/api/pulls?refresh=1', '/api/pulls?cursor=next', '/api/pulls?state=all']) {
    assert.equal((await fetch(base + path)).status, 200);
  }
  assert.equal(calls.length, 4);
  assert.equal(calls[2].cursor, 'next');
  assert.equal(calls[3].state, 'all');
});

test('HTTP serves the dashboard and rejects cross-origin, invalid host, unsafe paths and methods', async t => {
  const base = await server(t, async () => ({ items: [] }));
  const response = await fetch(base);
  assert.match(await response.text(), /gh-pull/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const headers of [{ origin: 'https://evil.example' }, { host: 'evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(base + '/api/pulls', { headers }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  assert.equal((await fetch(base + '/api/pulls?state=invalid')).status, 400);
  assert.equal((await fetch(base + '/api/pulls', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/github.js')).status, 404);
});

test('failed requests are not cached and secrets are not sent with unexpected errors', async t => {
  let count = 0;
  const base = await server(t, async () => {
    count++;
    if (count === 1) throw new ApiError('Please sign in.', 401);
    if (count === 2) throw new Error('secret-token');
    return { items: [] };
  });
  assert.equal((await fetch(base + '/api/pulls')).status, 401);
  const response = await fetch(base + '/api/pulls');
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /secret-token/);
  assert.equal((await fetch(base + '/api/pulls')).status, 200);
});

test('title updates validate input before contacting GitHub', async () => {
  const input = { id: 'PR_123', expectedTitle: 'Original', title: '  New title  ' };
  assert.equal(validateTitleUpdate(input).title, 'New title');
  const list = createGitHub({ getToken: async () => { throw new Error('must not request a token'); } });
  for (const invalid of [null, {}, { ...input, title: ' ' }, { ...input, title: 'x'.repeat(257) }, { ...input, title: 'a\nb' }, { ...input, id: '' }]) {
    await assert.rejects(list.updateTitle(invalid), { status: 400 });
  }
});

function titleClient({ author = 'alice', currentTitle = 'Original', type = 'PullRequest', mutationError = false } = {}) {
  const calls = [];
  const list = createGitHub({ getToken: async () => 'test-token', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (body.query.includes('mutation')) {
      if (mutationError) return Response.json({ errors: [{ message: 'Permission denied' }] });
      return Response.json({ data: { updatePullRequest: { pullRequest: { id: 'PR_123', title: body.variables.input.title, updatedAt: '2026-10-08T12:00:00Z' } } } });
    }
    return Response.json({ data: { viewer: { login: 'Alice' }, node: { __typename: type, id: 'PR_123', title: currentTitle, updatedAt: '2026-10-08T11:00:00Z', author: author ? { login: author } : null } } });
  } });
  return { list, calls };
}

test('title editing verifies author and sends only PR ID and title to the mutation', async () => {
  const { list, calls } = titleClient();
  const result = await list.updateTitle({ id: 'PR_123', title: 'New title', expectedTitle: 'Original', state: 'CLOSED' });
  assert.equal(result.title, 'New title');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].variables.input, { pullRequestId: 'PR_123', title: 'New title' });
});

test('title editing rejects other authors, missing authors, non-PRs and changed titles without mutating', async () => {
  for (const [options, status] of [[{ author: 'bob' }, 403], [{ author: null }, 403], [{ type: 'Issue' }, 404], [{ currentTitle: 'Changed elsewhere' }, 409]]) {
    const { list, calls } = titleClient(options);
    await assert.rejects(list.updateTitle({ id: 'PR_123', title: 'New title', expectedTitle: 'Original' }), { status });
    assert.equal(calls.length, 1);
  }
});

test('title retries are idempotent when a previous save succeeded', async () => {
  const { list, calls } = titleClient({ currentTitle: 'New title' });
  const result = await list.updateTitle({ id: 'PR_123', title: 'New title', expectedTitle: 'Original' });
  assert.equal(result.title, 'New title');
  assert.equal(calls.length, 1);
});

test('title editing propagates GitHub permission errors', async () => {
  const { list } = titleClient({ mutationError: true });
  await assert.rejects(list.updateTitle({ id: 'PR_123', title: 'New title', expectedTitle: 'Original' }), /Permission denied/);
});

test('title endpoint enforces same-origin JSON, input validation and body limits before writing', async t => {
  let writes = 0;
  const base = await server(t, async () => ({ items: [] }), async input => { writes++; return input; });
  const body = JSON.stringify({ id: 'PR_123', title: 'New title', expectedTitle: 'Original' });
  const send = (headers, payload = body) => fetch(base + '/api/pulls/title', { method: 'PATCH', headers, body: payload });
  assert.equal((await send({ 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await send({ Origin: 'https://evil.example', 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await send({ Origin: base, 'Content-Type': 'text/plain' })).status, 415);
  const headers = { Origin: base, 'Content-Type': 'application/json' };
  assert.equal((await send(headers, '{bad')).status, 400);
  assert.equal((await send(headers, '{}')).status, 400);
  assert.equal((await send(headers, JSON.stringify({ title: 'x'.repeat(9000) }))).status, 413);
  assert.equal(writes, 0);
  assert.equal((await send(headers)).status, 200);
  assert.equal(writes, 1);
});

test('saving a title invalidates cached PR pages', async t => {
  let reads = 0;
  const base = await server(t, async () => { reads++; return { items: [] }; }, async input => ({ id: input.id, title: input.title }));
  await fetch(base + '/api/pulls');
  await fetch(base + '/api/pulls');
  assert.equal(reads, 1);
  await fetch(base + '/api/pulls/title', {
    method: 'PATCH', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'PR_123', title: 'New title', expectedTitle: 'Original' }),
  });
  await fetch(base + '/api/pulls');
  assert.equal(reads, 2);
});

function draftClient(overrides = {}, error = false) {
  const calls = [];
  const current = { __typename: 'PullRequest', id: 'PR_123', state: 'OPEN', isDraft: false,
    updatedAt: '2026-10-08T12:00:00Z', reviewDecision: null, author: { login: 'alice' }, ...overrides };
  const list = createGitHub({ getToken: async () => 'test', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (body.query.includes('mutation')) {
      if (error) return Response.json({ errors: [{ message: 'Permission denied' }] });
      const ready = body.query.includes('markPullRequestReadyForReview');
      return Response.json({ data: { [ready ? 'markPullRequestReadyForReview' : 'convertPullRequestToDraft']: { pullRequest: { ...current, isDraft: !ready } } } });
    }
    return Response.json({ data: { viewer: { login: 'Alice' }, node: current } });
  } });
  return { list, calls };
}

test('draft conversion verifies ownership and uses the draft mutation', async () => {
  const { list, calls } = draftClient();
  const result = await list.convertToDraft({ id: 'PR_123' });
  assert.equal(result.status, 'DRAFT');
  assert.equal(result.review, 'NONE');
  assert.equal(calls.length, 2);
  assert.match(calls[1].query, /convertPullRequestToDraft/);
  assert.deepEqual(calls[1].variables, { input: { pullRequestId: 'PR_123' } });
});

test('draft conversion rejects invalid IDs, other authors and non-open PRs before mutating', async () => {
  const { list, calls } = draftClient();
  for (const input of [null, {}, { id: '' }, { id: 'x'.repeat(201) }]) await assert.rejects(list.convertToDraft(input), { status: 400 });
  assert.equal(calls.length, 0);
  for (const [overrides, status] of [
    [{ author: { login: 'bob' } }, 403], [{ author: null }, 403],
    [{ state: 'CLOSED' }, 409], [{ state: 'MERGED' }, 409], [{ __typename: 'Issue' }, 404],
  ]) {
    const { list, calls } = draftClient(overrides);
    await assert.rejects(list.convertToDraft({ id: 'PR_123' }), { status });
    assert.equal(calls.length, 1);
  }
});

test('draft conversion is idempotent and reports GitHub errors', async () => {
  const { list, calls } = draftClient({ isDraft: true });
  assert.equal((await list.convertToDraft({ id: 'PR_123' })).status, 'DRAFT');
  assert.equal(calls.length, 1);
  await assert.rejects(draftClient({}, true).list.convertToDraft({ id: 'PR_123' }), /Permission denied/);
});

test('draft endpoint requires same-origin valid JSON and invalidates cached pages', async t => {
  let reads = 0, writes = 0;
  const base = await server(t, async () => { reads++; return { items: [] }; }, undefined,
    async input => { writes++; return { id: input.id, status: 'DRAFT' }; });
  await fetch(base + '/api/pulls');
  const send = (headers, body = '{"id":"PR_123"}') => fetch(base + '/api/pulls/draft', { method: 'PATCH', headers, body });
  assert.equal((await send({ 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await send({ Origin: 'https://evil.example', 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await send({ Origin: base, 'Content-Type': 'text/plain' })).status, 415);
  const headers = { Origin: base, 'Content-Type': 'application/json' };
  assert.equal((await send(headers, '{}')).status, 400);
  assert.equal((await send(headers, '{bad')).status, 400);
  assert.equal(writes, 0);
  const result = await send(headers);
  assert.equal(result.status, 200); assert.equal((await result.json()).status, 'DRAFT');
  assert.equal(writes, 1);
  await fetch(base + '/api/pulls'); assert.equal(reads, 2);
});

test('marking ready uses the correct mutation and repeated requests are idempotent', async () => {
  const { list, calls } = draftClient({ isDraft: true });
  const result = await list.markReadyForReview({ id: 'PR_123' });
  assert.equal(result.status, 'OPEN');
  assert.match(calls[1].query, /markPullRequestReadyForReview/);
  assert.deepEqual(calls[1].variables, { input: { pullRequestId: 'PR_123' } });
  const alreadyReady = draftClient();
  assert.equal((await alreadyReady.list.markReadyForReview({ id: 'PR_123' })).status, 'OPEN');
  assert.equal(alreadyReady.calls.length, 1);
});

test('marking ready validates IDs, ownership, PR state and handles GitHub failure', async () => {
  await assert.rejects(draftClient().list.markReadyForReview({}), { status: 400 });
  for (const [overrides, status] of [[{ author: { login: 'bob' } }, 403], [{ state: 'CLOSED' }, 409], [{ state: 'MERGED' }, 409]]) {
    const { list, calls } = draftClient({ isDraft: true, ...overrides });
    await assert.rejects(list.markReadyForReview({ id: 'PR_123' }), { status });
    assert.equal(calls.length, 1);
  }
  await assert.rejects(draftClient({ isDraft: true }, true).list.markReadyForReview({ id: 'PR_123' }), /Permission denied/);
});

test('ready endpoint enforces same-origin JSON and clears the cache after success', async t => {
  let reads = 0, writes = 0;
  const base = await server(t, async () => { reads++; return { items: [] }; }, undefined, undefined,
    async input => { writes++; return { id: input.id, status: 'OPEN' }; });
  await fetch(base + '/api/pulls');
  const send = (headers, body = '{"id":"PR_123"}') => fetch(base + '/api/pulls/ready', { method: 'PATCH', headers, body });
  assert.equal((await send({ 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await send({ Origin: 'https://evil.example', 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await send({ Origin: base, 'Content-Type': 'text/plain' })).status, 415);
  const headers = { Origin: base, 'Content-Type': 'application/json' };
  assert.equal((await send(headers, '{}')).status, 400);
  assert.equal(writes, 0);
  const response = await send(headers);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'OPEN');
  assert.equal(writes, 1);
  await fetch(base + '/api/pulls'); assert.equal(reads, 2);
});
