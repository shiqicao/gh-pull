import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeQuery, queryPresets, setQueryPreset, normalizeQuery, toGitHubQuery, queryError, queryFromParams, queryCompletions, DEFAULT_QUERY } from '../public/query.js';
import { createApp } from '../server.js';
import { createGitHub } from '../github.js';
import { groupPulls } from '../public/model.js';

test('query tokens preserve quotes, exclusions, original case and caret ranges', () => {
  const query = 'is:pr label:"Good first issue" -author:Bob "sort:updated-desc"';
  const tokens = tokenizeQuery(query);
  assert.deepEqual(tokens.map(t => t.raw), ['is:pr', 'label:"Good first issue"', '-author:Bob', '"sort:updated-desc"']);
  for (const token of tokens) assert.equal(query.slice(token.from, token.to), token.raw);
  assert.equal(tokens[2].negative, true);
  assert.equal(tokens[3].key, null);
  assert.equal(normalizeQuery('  label:"Good first issue"  -author:Bob  '), 'label:"Good first issue" -author:Bob');
});

test('validation restricts results to PRs and bounds malformed or unsupported input', () => {
  for (const query of ['is:pr', 'type:pr', 'is:issue', 'type:issue', '-is:pr', '-type:pr', '-is:issue', 'repo:', 'label:""', 'label:"unclosed', 'x\ny', 'a'.repeat(2001), 'a OR b', '(repo:a repo:b)']) {
    assert.ok(queryError(query), query);
    assert.throws(() => normalizeQuery(query));
  }
  for (const query of ['', 'is:open', 'label:"AND (OR)"', 'updated:>=2026-01-01', 'author:app/robot', '-label:wip', 'label:"quote\\\"here"']) assert.equal(queryError(query), null, query);
  assert.equal(normalizeQuery(''), '');
});

test('PR-only constraint belongs to server queries and never appears in suggestions', () => {
  assert.equal(toGitHubQuery(''), 'is:pr');
  assert.equal(toGitHubQuery(DEFAULT_QUERY), `is:pr ${DEFAULT_QUERY}`);
  assert.equal(toGitHubQuery('is:open "is:issue"'), 'is:pr is:open "is:issue"');
  for (const value of ['is:pr', 'type:pr', 'is:issue', '-is:pr']) assert.throws(() => toGitHubQuery(value));
  assert.ok(!queryCompletions('is:', 3).options.some(o => ['pr', 'issue'].includes(o.label)));
});

test('presets reflect custom and conflicting qualifiers without hiding constraints', () => {
  assert.deepEqual(queryPresets(DEFAULT_QUERY), { scope: 'involved', state: 'open', sort: 'updated' });
  assert.deepEqual(queryPresets('is:pr'), { scope: 'all', state: 'all', sort: 'relevance' });
  assert.equal(queryPresets('state:open').state, 'open');
  for (const query of ['author:alice', '-author:@me', 'author:@me involves:@me', 'author:@me author:@me']) assert.equal(queryPresets(query).scope, 'custom');
  for (const query of ['is:open draft:false', 'is:closed', '-is:open', 'is:merged is:unmerged']) assert.equal(queryPresets(query).state, 'custom');
  assert.equal(queryPresets('sort:comments-desc').sort, 'custom');
  assert.equal(queryPresets('"author:@me"').scope, 'all');
});

test('preset edits preserve unrelated query terms and replace the whole corresponding constraint', () => {
  const query = 'is:pr repo:owner/repo -author:bot author:alice label:"Good first issue" is:open draft:false sort:comments-desc';
  const scope = setQueryPreset(query, 'scope', 'involved');
  assert.equal(scope, 'is:pr repo:owner/repo label:"Good first issue" is:open draft:false sort:comments-desc involves:@me');
  const state = setQueryPreset(scope, 'state', 'closed');
  assert.equal(queryPresets(state).state, 'closed');
  assert.ok(!state.includes('draft:'));
  assert.ok(!state.includes('is:open'));
  const sort = setQueryPreset(state, 'sort', 'oldest');
  assert.equal(queryPresets(sort).sort, 'oldest');
  assert.ok(!sort.includes('comments-desc'));
  assert.equal(queryPresets(setQueryPreset(sort, 'state', 'all')).state, 'all');
  assert.equal(setQueryPreset(query, 'scope', 'custom'), query);
});

test('URLs migrate old filters and favor the complete query over legacy parameters', () => {
  assert.equal(queryFromParams(new URLSearchParams()), DEFAULT_QUERY);
  const legacy = queryFromParams(new URLSearchParams('scope=authored&state=all&sort=oldest&search=keyboard'));
  assert.deepEqual(queryPresets(legacy), { scope: 'authored', state: 'all', sort: 'oldest' });
  assert.ok(legacy.endsWith(' keyboard'));
  assert.equal(queryFromParams(new URLSearchParams('q=repo:one/two&scope=authored')), 'repo:one/two');
  assert.equal(queryFromParams(new URLSearchParams('q=')), '');
  assert.equal(queryFromParams(new URLSearchParams('q=is:pr+is:open+type:pr')), 'is:open');
  assert.equal(queryFromParams(new URLSearchParams('q=is:issue')), 'is:issue');
});

test('completion replaces only the active token, with quoted labels and local metadata', () => {
  const items = [{ repo: 'owner/repo', author: 'alice', labels: ['good first issue', 'bug'], branch: 'fix/nav', reviewers: [{ name: 'bob' }, { name: 'owner/team' }] }];
  const query = 'is:pr repo:ow label:bug';
  const completion = queryCompletions(query, 12, items);
  assert.equal(query.slice(completion.from, completion.to), 'ow');
  assert.ok(completion.options.some(o => o.label === 'owner/repo'));
  assert.ok(queryCompletions('label:', 6, items).options.some(o => o.label === '"good first issue"'));
  assert.deepEqual(queryCompletions('author:', 7, items).options.map(o => o.label), ['@me', 'alice', 'bob']);
  assert.equal(queryCompletions('"a phrase', 9, items), null);
  assert.equal(queryCompletions('', 0, items), null);
  assert.ok(queryCompletions('', 0, items, true).options.some(o => o.label === 'repo:'));
  assert.ok(queryCompletions('-aut', 4).options.some(o => o.label === '-author:'));
});

test('custom searches pass their full query and cursor through GraphQL variables', async () => {
  let body;
  const list = createGitHub({ getToken: async () => 'test', fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return Response.json({ data: { viewer: { login: 'alice' }, search: { issueCount: 1100, pageInfo: { endCursor: 'next', hasNextPage: true }, nodes: [] } } });
  } });
  const query = 'is:pr repo:owner/repo label:"good first issue" sort:comments-desc';
  const result = await list({ query, cursor: 'previous' });
  assert.deepEqual(body.variables, { query, cursor: 'previous' });
  assert.equal(result.limited, true);
  assert.equal(result.pageInfo.endCursor, 'next');
});

test('query HTTP cache isolates searches and cursors, refresh bypasses it, invalid queries never reach GitHub', async t => {
  const calls = [];
  const app = createApp({ list: async args => { calls.push(args); return { items: [], total: 0 }; } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const fetchQuery = (q, extra = {}) => fetch(`${origin}/api/pulls?${new URLSearchParams({ q, ...extra })}`);
  for (const [q, extra] of [['repo:a/b'], ['repo:a/b'], ['repo:c/d'], ['repo:a/b', { cursor: 'next' }], ['repo:a/b', { refresh: '1' }]]) assert.equal((await fetchQuery(q, extra)).status, 200);
  assert.deepEqual(calls, [
    { query: 'is:pr repo:a/b', cursor: null }, { query: 'is:pr repo:c/d', cursor: null },
    { query: 'is:pr repo:a/b', cursor: 'next' }, { query: 'is:pr repo:a/b', cursor: null },
  ]);
  for (const q of ['is:pr', 'type:pr', 'is:issue', '-is:pr']) assert.equal((await fetchQuery(q)).status, 400);
  assert.equal(calls.length, 4);
  const page = await fetch(origin);
  const html = await page.text();
  const nonce = /name="style-nonce" content="([^"]+)"/.exec(html)[1];
  assert.ok(page.headers.get('content-security-policy').includes(`'nonce-${nonce}'`));
  assert.match(page.headers.get('content-security-policy'), /script-src 'self';/);
  assert.match(page.headers.get('content-security-policy'), /style-src 'self' 'nonce-[^']+';/);
  assert.ok(!html.includes('STYLE_NONCE'));
  const font = await fetch(`${origin}/fonts/InterVariable-4.1.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), 'wOF2');
  for (const asset of ['fonts/Inter-LICENSE.txt', 'theme.css', 'style.css', 'query-editor.css', 'query.js', 'query-editor.js', 'vendor/codemirror.js', 'vendor/codemirror.LICENSE.txt']) assert.equal((await fetch(`${origin}/${asset}`)).status, 200);
});

test('grouping preserves GitHub query ranking within groups', () => {
  const items = [{ id: 'b', repo: 'a/b', labels: [] }, { id: 'a', repo: 'a/b', labels: [] }];
  assert.deepEqual(groupPulls(items, { sort: 'query' }).groups[0][1], items);
});

test('state filters exclude stale search membership while keeping drafts and merged history', async () => {
  const { matchesQueryState } = await import('../public/query.js');
  const filter = query => ['OPEN', 'DRAFT', 'CLOSED', 'MERGED'].filter(status => matchesQueryState({ status }, query));
  assert.deepEqual(filter('is:open'), ['OPEN', 'DRAFT']);
  assert.deepEqual(filter('state:open draft:false'), ['OPEN']);
  assert.deepEqual(filter('is:open draft:true'), ['DRAFT']);
  assert.deepEqual(filter('is:closed'), ['CLOSED', 'MERGED']);
  assert.deepEqual(filter('is:closed is:unmerged'), ['CLOSED']);
  assert.deepEqual(filter('is:merged'), ['MERGED']);
  assert.deepEqual(filter('-is:merged'), ['OPEN', 'DRAFT', 'CLOSED']);
  assert.deepEqual(filter('repo:example/app'), ['OPEN', 'DRAFT', 'CLOSED', 'MERGED']);
});

test('review status sort persists in queries and uses supported upstream ordering', () => {
  const query = setQueryPreset('is:open sort:created-desc', 'sort', 'review');
  assert.equal(query, 'is:open sort:review-status');
  assert.equal(queryPresets(query).sort, 'review');
  assert.equal(toGitHubQuery(query), 'is:pr is:open sort:updated-desc');
  assert.equal(toGitHubQuery('"sort:review-status"'), 'is:pr "sort:review-status"');
});

test('review status sort prioritizes action and breaks ties by recency', () => {
  const items = ['NONE', 'APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'REVIEW_BYPASS_AVAILABLE'].map((review, i) => ({
    id: String(i), review, title: '', labels: [], updatedAt: `2026-10-${20+i}T00:00:00Z`,
  }));
  assert.deepEqual(groupPulls(items, { group: 'none', sort: 'review' }).groups[0][1].map(p => p.id), ['3', '5', '4', '2', '1', '0']);
});
