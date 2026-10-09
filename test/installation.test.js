import test from 'node:test';
import assert from 'node:assert/strict';
import { createMergeAccess } from '../installation.js';

const installUrl = 'https://github.com/apps/gh-pr-dashboard/installations/new';
const installation = { id: 12, account: { login: 'team' }, app_slug: 'gh-pr-dashboard', permissions: { contents: 'write' }, html_url: 'https://github.com/organizations/team/settings/installations/12', suspended_at: null };
function fixture({ installations = [installation], repositories = [{ full_name: 'team/repo' }], fail = null } = {}) {
  const calls = [];
  const options = { installations, repositories, fail };
  let token = 'alice';
  const check = createMergeAccess({ installUrl, getToken: async () => token, fetchImpl: async (url, request) => {
    calls.push({ url, authorization: request.headers.Authorization });
    if (options.fail) return new Response('', { status: options.fail });
    return Response.json(url.includes('/repositories?') ? { repositories: options.repositories } : { installations: options.installations });
  } });
  return { check, calls, options, setToken: value => { token = value; } };
}

test('hosted merge access distinguishes missing installation, repository, permission and suspension', async () => {
  for (const [options, reason, action] of [
    [{ installations: [] }, 'not_installed', 'Install GitHub App'],
    [{ repositories: [] }, 'repository_required', 'Grant repository access'],
    [{ installations: [{ ...installation, permissions: { contents: 'read' } }] }, 'permission_required', 'Review app permissions'],
    [{ installations: [{ ...installation, suspended_at: '2026-10-09' }] }, 'suspended', 'Manage app access'],
  ]) {
    const { check } = fixture(options);
    const access = (await check(['team/repo'])).get('team/repo');
    assert.equal(access.allowed, false);
    assert.equal(access.reason, reason);
    assert.equal(access.action, action);
    assert.equal(access.url, reason === 'not_installed' ? installUrl : installation.html_url);
  }
  const { check, calls } = fixture();
  assert.equal((await check(['TEAM/REPO', 'team/other'])).get('TEAM/REPO').allowed, true);
  assert.equal(calls.length, 2, 'one repository lookup per owner');
});

test('refresh observes newly granted or revoked access and uses the latest session token', async () => {
  const { check, calls, options, setToken } = fixture({ installations: [] });
  assert.equal((await check(['team/repo'])).get('team/repo').allowed, false);
  options.installations = [installation];setToken('rotated');
  assert.equal((await check(['team/repo'])).get('team/repo').allowed, true);
  assert.equal(calls.at(-1).authorization, 'Bearer rotated');
  options.repositories = [];
  assert.equal((await check(['team/repo'])).get('team/repo').allowed, false);
});

test('unavailable access checks disable merges without claiming the app is uninstalled; 401 requires sign-in', async () => {
  for (const fail of [403, 429, 500]) {
    const access = (await fixture({ fail }).check(['team/repo'])).get('team/repo');
    assert.equal(access.allowed, false);assert.equal(access.reason, 'unverified');assert.equal(access.url, null);
  }
  await assert.rejects(fixture({ fail: 401 }).check(['team/repo']), { status: 401 });
  const f = fixture();await f.check([]);assert.equal(f.calls.length, 0);
});

test('installation and repository pagination covers later pages without checking unrelated installations', async () => {
  const calls = [];
  const check = createMergeAccess({ getToken: async () => 'token', fetchImpl: async url => {
    calls.push(url);
    const first = new URL(url).searchParams.get('page') === '1';
    if (url.includes('/repositories?')) return Response.json({ repositories: first ? Array.from({ length: 100 }, (_, n) => ({ full_name: `team/other-${n}` })) : [{ full_name: 'team/repo' }] });
    return Response.json({ installations: first ? Array.from({ length: 100 }, (_, n) => ({ ...installation, id: n + 100, account: { login: `other-${n}` } })) : [installation] });
  } });
  const access = await check(['team/repo', 'new/repo']);
  assert.equal(access.get('team/repo').allowed, true);
  assert.equal(access.get('new/repo').url, installUrl, 'discover slug from existing installation');
  assert.equal(calls.length, 4);
});

test('unsafe installation URLs are discarded and missing slugs do not invent an app link', async () => {
  const { check } = fixture({ installations: [{ ...installation, html_url: 'https://evil.example', permissions: {} }] });
  assert.equal((await check(['team/repo'])).get('team/repo').url, installUrl);
  const unknown = createMergeAccess({ getToken: async () => 'token', fetchImpl: async () => Response.json({ installations: [] }) });
  assert.equal((await unknown(['team/repo'])).get('team/repo').url, null);
});
