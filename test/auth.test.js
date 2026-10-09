import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { authConfig } from '../auth.js';
import { createApp } from '../server.js';
import { createGitHub } from '../github.js';

async function fixture(t, { secure = false, mergeable = false } = {}) {
  let clock = Date.now();
  const config = authConfig({ AUTH_MODE: 'github-app', PUBLIC_URL: secure ? 'https://dashboard.example' : 'http://localhost',
    GITHUB_APP_CLIENT_ID: 'client-id', GITHUB_APP_CLIENT_SECRET: 'secret-not-for-browser', GITHUB_APP_SLUG: 'gh-pull' });
  const exchanges = [], calls = [];
  let failRefresh = false, revoked = false;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/login/oauth/access_token')) {
      const data = new URLSearchParams(options.body);
      exchanges.push(data);
      if (data.get('code') === 'bad' || (failRefresh && data.has('refresh_token'))) return Response.json({ error: 'bad_verification_code', error_description: 'secret-not-for-browser' });
      const user = data.get('code') || data.get('refresh_token').split(':')[1];
      return Response.json({ access_token: `access:${user}:${exchanges.length}`, expires_in: 3600,
        refresh_token: `refresh:${user}`, refresh_token_expires_in: 86400 });
    }
    const user = options.headers.Authorization.split(':')[1];
    if (url.includes('/user/installations')) {
      if (url.includes('/repositories?')) return Response.json({ repositories: [{ full_name: 'team/repo' }] });
      return Response.json({ installations: user === 'alice' ? [{ id: 12, account: { login: 'team' }, permissions: { contents: 'write' } }] : [] });
    }
    const data = JSON.parse(options.body);
    calls.push({ user, ...data, authorization: options.headers.Authorization });
    if (revoked) return new Response('', { status: 401 });
    if (data.query.includes('nodes(ids:')) return Response.json({ data: { viewer: { login: user }, nodes: [] } });
    if (data.query.includes('updatePullRequest(')) return Response.json({ data: { updatePullRequest: { pullRequest: { id: 'PR_one', title: 'New title', updatedAt: '2026-10-09' } } } });
    if (data.query.includes('node(id:')) return Response.json({ data: { viewer: { login: user }, node: { __typename: 'PullRequest', id: 'PR_one', title: 'Old title', author: { login: user } } } });
    const connection = { totalCount: 0, issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
    if (mergeable) connection.nodes = [{ id: 'PR_merge', number: 1, author: { login: user }, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'a'.repeat(40), repository: { nameWithOwner: 'team/repo', viewerPermission: 'WRITE', squashMergeAllowed: true }, commits: { nodes: [] }, labels: { nodes: [] } }];
    return Response.json({ data: { viewer: { login: user, pullRequests: connection }, search: connection } });
  };
  const app = createApp({ config, list: async () => { throw new Error('Local credentials must never be used'); },
    authOptions: { now: () => clock, fetchImpl, githubFactory: options => createGitHub({ ...options, fetchImpl }) } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  function call(path, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = request(base + path, { method, headers: { host: new URL(config.origin).host, ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); });
      });
      req.on('error', reject); req.end(body);
    });
  }
  const cookies = response => (response.headers['set-cookie'] ?? []).map(value => value.split(';')[0]).join('; ');
  async function begin() {
    const response = await call('/auth/login');
    const target = new URL(response.headers.location);
    return { response, target, cookie: cookies(response), state: target.searchParams.get('state') };
  }
  async function login(user = 'alice') {
    const start = await begin();
    const response = await call(`/auth/callback?state=${start.state}&code=${user}`, { headers: { cookie: start.cookie, 'sec-fetch-site': 'cross-site' } });
    assert.equal(response.headers.location, '/');
    return { cookie: cookies(response), response, start };
  }
  return { call, begin, login, config, exchanges, calls, advance: ms => { clock += ms; }, revoke: () => { revoked = true; }, failRefresh: () => { failRefresh = true; } };
}

test('authentication config defaults to local and rejects incomplete or unsafe hosted configuration', () => {
  assert.deepEqual(authConfig({}), { mode: 'local' });
  assert.throws(() => authConfig({ AUTH_MODE: 'typo' }), /AUTH_MODE/);
  assert.throws(() => authConfig({ AUTH_MODE: 'github-app' }), /requires/);
  for (const PUBLIC_URL of ['http://public.example', 'https://example.com/path', 'https://user:password@example.com', 'https://example.com?next=evil']) {
    assert.throws(() => authConfig({ AUTH_MODE: 'github-app', PUBLIC_URL, GITHUB_APP_CLIENT_ID: 'id', GITHUB_APP_CLIENT_SECRET: 'secret' }));
  }
});

test('hosted mode serves sign-in assets but protects API data and uses secure cookies', async t => {
  const f = await fixture(t, { secure: true });
  assert.equal((await f.call('/')).status, 200);
  assert.deepEqual((await f.call('/api/session')).json(), { mode: 'github-app', authenticated: false, installUrl: 'https://github.com/apps/gh-pull/installations/new' });
  assert.equal((await f.call('/api/pulls')).status, 401);
  assert.equal(f.calls.length, 0);
  const { response, target } = await f.begin();
  assert.equal(target.origin, 'https://github.com');
  assert.equal(target.searchParams.get('redirect_uri'), 'https://dashboard.example/auth/callback');
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.match(response.headers['set-cookie'][0], /__Host-gh-pull-state=.*HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  const { response: signedIn } = await f.login();
  assert.match(signedIn.headers['set-cookie'][1], /__Host-gh-pull-session=.*HttpOnly; SameSite=Lax; Max-Age=604800; Secure/);
  assert.doesNotMatch(JSON.stringify(signedIn), /access:alice|refresh:alice|secret-not-for-browser/);
});

test('OAuth state is browser-bound, expires, and cannot be replayed; exchange uses PKCE', async t => {
  const f = await fixture(t);
  const start = await f.begin();
  const path = `/auth/callback?state=${start.state}&code=alice`;
  assert.equal((await f.call(path)).headers.location, '/?auth_error=state');
  assert.equal(f.exchanges.length, 0);
  const valid = await f.call(path, { headers: { cookie: start.cookie } });
  assert.equal(valid.headers.location, '/');
  const exchange = f.exchanges[0];
  assert.equal(exchange.get('client_secret'), 'secret-not-for-browser');
  assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), start.target.searchParams.get('code_challenge'));
  assert.equal((await f.call(path, { headers: { cookie: start.cookie } })).headers.location, '/?auth_error=state');
  const old = await f.begin();
  f.advance(11 * 60_000);
  assert.equal((await f.call(`/auth/callback?state=${old.state}&code=alice`, { headers: { cookie: old.cookie } })).headers.location, '/?auth_error=state');
  assert.equal(f.exchanges.length, 1);
});

test('cancelled and failed OAuth flows return safe retry messages without a session', async t => {
  const f = await fixture(t);
  for (const [query, expected] of [['error=access_denied', 'denied'], ['code=bad', 'exchange']]) {
    const start = await f.begin();
    const response = await f.call(`/auth/callback?state=${start.state}&${query}`, { headers: { cookie: start.cookie } });
    assert.equal(response.headers.location, `/?auth_error=${expected}`);
    assert.doesNotMatch(JSON.stringify(response), /secret-not-for-browser|access:/);
  }
});

test('users have separate API clients and caches; mutations use the session user and invalidate only its cache', async t => {
  const f = await fixture(t);
  const alice = await f.login('alice'), bob = await f.login('bob');
  const get = cookie => f.call('/api/pulls', { headers: { cookie } });
  assert.equal((await get(alice.cookie)).json().viewer, 'alice');
  assert.equal((await get(bob.cookie)).json().viewer, 'bob');
  await get(alice.cookie); await get(bob.cookie);
  assert.equal(f.calls.length, 2);
  const response = await f.call('/api/pulls/title', { method: 'PATCH', headers: { cookie: alice.cookie, origin: f.config.origin, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'PR_one', title: 'New title', expectedTitle: 'Old title' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls.slice(2).map(call => call.user), ['alice', 'alice']);
  await get(bob.cookie);
  assert.equal(f.calls.length, 4);
  await get(alice.cookie);
  assert.equal(f.calls.length, 5);
});

test('hosted mode rejects cross-origin reads, writes, logout, and forged hosts', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  for (const headers of [{ host: 'evil.example' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await f.call('/api/pulls', { headers: { cookie, ...headers } })).status, 403);
  }
  assert.equal((await f.call('/api/pulls/title', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await f.call('/auth/logout', { method: 'POST', headers: { cookie } })).status, 403);
  assert.equal((await f.call('/auth/logout', { headers: { cookie } })).status, 405);
  assert.equal((await f.call('//[')).status, 400);
  assert.equal((await f.call('/api/session', { headers: { cookie } })).json().authenticated, true);
});

test('logout invalidates the server session, not just the browser cookie', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  assert.equal((await f.call('/api/pulls', { headers: { cookie } })).status, 200);
  const response = await f.call('/auth/logout', { method: 'POST', headers: { cookie, origin: f.config.origin } });
  assert.equal(response.status, 200);
  assert.match(response.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await f.call('/api/pulls', { headers: { cookie } })).status, 401);
});

test('expiring tokens rotate once for concurrent requests and all requests use the new token', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  await f.call('/api/pulls', { headers: { cookie } });
  f.advance(3600_000);
  const results = await Promise.all(['/api/pulls?refresh=1', '/api/pulls?state=all'].map(path => f.call(path, { headers: { cookie } })));
  assert.ok(results.every(result => result.status === 200));
  assert.equal(f.exchanges.length, 2);
  assert.equal(f.exchanges[1].get('grant_type'), 'refresh_token');
  assert.ok(f.calls.slice(1).every(call => call.authorization === 'Bearer access:alice:2'));
});

test('expired sessions and rejected refresh tokens require sign-in again', async t => {
  const f = await fixture(t);
  const alice = await f.login();
  f.advance(3600_000); f.failRefresh();
  const response = await f.call('/api/pulls', { headers: { cookie: alice.cookie } });
  assert.equal(response.status, 401);
  assert.doesNotMatch(response.text, /secret-not-for-browser|gh auth login/);
  assert.equal((await f.call('/api/session', { headers: { cookie: alice.cookie } })).json().authenticated, false);
  const bob = await f.login('bob');
  f.advance(8 * 86400_000);
  assert.equal((await f.call('/api/session', { headers: { cookie: bob.cookie } })).json().authenticated, false);
});

test('revoked GitHub access invalidates a session and never falls back to local credentials', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  f.revoke();
  const response = await f.call('/api/pulls', { headers: { cookie } });
  assert.equal(response.status, 401);
  assert.match(response.text, /sign in again/);
  assert.doesNotMatch(response.text, /gh auth login|Local credentials/);
  assert.equal((await f.call('/api/session', { headers: { cookie } })).json().authenticated, false);
});

test('merge readiness uses each hosted session and rejects anonymous requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/pulls/readiness?id=PR_1')).status, 401);
  const alice = await f.login('alice'), bob = await f.login('bob');
  for (const { cookie } of [alice, bob]) {
    assert.equal((await f.call('/api/pulls/readiness?id=PR_1', { headers: { cookie } })).status, 200);
  }
  assert.deepEqual(f.calls.map(call => call.user), ['alice', 'bob']);
});


test('hosted list keeps mergeability and checks installation access separately for each session', async t => {
  const f = await fixture(t, { mergeable: true });
  const alice = await f.login('alice'), bob = await f.login('bob');
  const a = (await f.call('/api/pulls', { headers: { cookie: alice.cookie } })).json().items[0];
  const b = (await f.call('/api/pulls', { headers: { cookie: bob.cookie } })).json().items[0];
  assert.equal(a.canMerge, true);assert.equal(a.mergeAccess.allowed, true);
  assert.equal(b.canMerge, true);assert.equal(b.mergeAccess.reason, 'not_installed');
  assert.equal(b.mergeAccess.url, 'https://github.com/apps/gh-pull/installations/new');
});
