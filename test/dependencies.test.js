import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencyForest } from '../public/model.js';
const pr = (id, baseBranch = 'main', extra = {}) => ({ id, branch: id, baseBranch, repo: 'org/repo', branchRepository: 'org/repo', status: 'OPEN', ...extra });
const shape = nodes => nodes.map(n => [n.pr.id, shape(n.children)]);
test('orders parents before children and preserves sibling order from query', () => {
  assert.deepEqual(shape(dependencyForest([pr('C', 'B'), pr('B', 'A'), pr('D', 'A'), pr('A')])),
    [['A', [['B', [['C', []]]], ['D', []]]]]);
});
test('missing parents, forks, ambiguous heads and inactive PRs stay independent', () => {
  for (const extra of [{ branchRepository: 'fork/repo' }, { status: 'MERGED' }, { status: 'CLOSED' }, { branchRepository: null }]) {
    assert.equal(dependencyForest([pr('A', 'main', extra), pr('B', 'A')]).length, 2);
  }
  assert.equal(dependencyForest([pr('B', 'missing')]).length, 1);
  assert.equal(dependencyForest([pr('A'), pr('duplicate', 'main', { branch: 'A' }), pr('B', 'A')]).length, 3);
  assert.equal(dependencyForest([pr('A'), pr('B', 'A', { repo: 'other/repo' })]).length, 2);
});
test('drafts are connected; cycles and self references retain every PR exactly once', () => {
  assert.equal(dependencyForest([pr('A'), pr('B', 'A', { status: 'DRAFT' })])[0].children.length, 1);
  const forest = dependencyForest([pr('A', 'B'), pr('B', 'C'), pr('C', 'A'), pr('D', 'D')]);
  const ids = [];
  const visit = nodes => nodes.forEach(n => { ids.push(n.pr.id); visit(n.children); });
  visit(forest);
  assert.deepEqual(ids.sort(), ['A', 'B', 'C', 'D']);
});

test('API normalization preserves base branch and fork repository identity', async () => {
  const { normalizePullRequest } = await import('../pull-request.js');
  const normalized = normalizePullRequest({ id: 'x', headRefName: 'feature', baseRefName: 'parent',
    headRepository: { nameWithOwner: 'fork/repo' }, repository: { nameWithOwner: 'org/repo' },
    commits: { nodes: [] }, labels: { nodes: [] } });
  assert.equal(normalized.baseBranch, 'parent');
  assert.equal(normalized.branchRepository, 'fork/repo');
});

import { dependencyLanes, dependencyStatus } from '../public/model.js';
import { scenario3a, scenario3b } from '../scripts/dependency-fixtures.mjs';
test('handoff 3a: DFS and ascending children allocate the expected four noncrossing lanes', () => {
  const graph = dependencyLanes([...scenario3a].reverse(), { sort: 'updated' });
  assert.equal(graph.gutter, 92);
  assert.deepEqual(graph.rows.map(n => n.pr.number), [495, 503, 504, 507, 509, 510, 506, 511, 520]);
  assert.deepEqual(graph.rows.map(n => n.lane), [0, 0, 0, 0, 0, 1, 2, 3, null]);
});
test('handoff 3b: independent stacks, standalone gaps, external parents and lane reuse', () => {
  const graph = dependencyLanes([...scenario3b].reverse(), { sort: 'updated' });
  assert.equal(graph.gutter, 52);
  assert.deepEqual(graph.rows.map(n => n.pr.number), [512, 513, 515, 514, 520, 516, 517, 490]);
  assert.deepEqual(graph.rows.map(n => n.lane), [0, 0, 0, 1, null, 0, 0, null]);
  assert.equal(graph.rows[5].externalParent.number, 488);
  assert.equal(graph.rows[5].parentIndex, -1);
});
test('default branches, closed/filtered parents, wide forks and standalone-only groups', () => {
  const parent = pr('A', 'main', { number: 1 }), child = pr('B', 'A', { number: 2 });
  assert.equal(dependencyLanes([child], { allItems: [parent, child] }).rows[0].externalParent.number, 1);
  assert.equal(dependencyLanes([{ ...parent, status: 'CLOSED' }, child]).rows[1].externalParent.number, 1);
  assert.equal(dependencyLanes([{ ...parent, status: 'MERGED' }, child]).gutter, 0);
  assert.equal(dependencyLanes([parent, { ...child, defaultBranch: 'A' }]).gutter, 0);
  const wide = dependencyLanes([parent, ...Array.from({ length: 6 }, (_, i) => pr(`child${i}`, 'A', { number: i + 2 }))]);
  assert.equal(wide.gutter, 92);
  assert.deepEqual(wide.rows.map(n => n.lane), [0, 0, 1, 2, 3, 4, 5]);
  assert.equal(dependencyLanes([parent]).gutter, 0);
});
test('node readiness colours prioritize failed and running checks over approval', () => {
  assert.equal(dependencyStatus({ checks: 'FAILURE', review: 'APPROVED' }), 'failed');
  assert.equal(dependencyStatus({ checks: 'PENDING', canMerge: true }), 'running');
  assert.equal(dependencyStatus({ checks: 'SUCCESS', review: 'APPROVED' }), 'ready');
  assert.equal(dependencyStatus({ canMerge: true, mergeUnstable: true }), 'review');
  assert.equal(dependencyStatus({ canMerge: true, mergeUnstable: true, review: 'APPROVED' }), 'ready');
  assert.equal(dependencyStatus({ status: 'DRAFT', review: 'APPROVED' }), 'review');
});

import { createGitHub } from '../github.js';
test('hidden parent lookup is cached, ignores forks/default branches and tolerates failures', async () => {
  const raw = { id: 'child', number: 516, state: 'OPEN', isDraft: false, headRefName: 'child', baseRefName: 'parent',
    repository: { nameWithOwner: 'org/repo', defaultBranchRef: { name: 'main' } },
    headRepository: { nameWithOwner: 'org/repo' }, commits: { nodes: [] }, labels: { nodes: [] } };
  for (const state of ['OPEN', 'CLOSED', 'MERGED', 'fork', 'failure', 'ambiguous', 'truncated']) {
    let lookups = 0;
    const list = createGitHub({ getToken: async () => 'test', fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('query DependencyParents')) {
        lookups++;
        assert.match(body.query, /states: \[OPEN, CLOSED, MERGED\]/);
        assert.equal(body.variables.branch0, 'parent');
        assert.equal(body.variables.owner0, 'org');
        assert.equal(body.variables.repo0, 'repo');
        if (state === 'failure') return new Response('', { status: 500 });
        const parent = { id: 'parent', number: 488, state: ['CLOSED', 'MERGED'].includes(state) ? state : 'OPEN', headRefName: 'parent', headRepository: { nameWithOwner: state === 'fork' ? 'fork/repo' : 'org/repo' } };
        return Response.json({ data: { p0: { pullRequests: { pageInfo: { hasNextPage: state === 'truncated' }, nodes: state === 'ambiguous' ? [parent, { ...parent, id: 'other' }] : [parent] } } } });
      }
      return Response.json({ data: { viewer: { login: 'viewer' }, search: { issueCount: 2, pageInfo: {}, nodes: [raw, { ...raw, id: 'root', baseRefName: 'main' }] } } });
    } });
    for (let i = 0; i < 2; i++) {
      const result = await list({ query: 'is:pr' });
      assert.equal(result.items[0].dependencyParent?.number ?? null, ['OPEN', 'CLOSED', 'MERGED'].includes(state) ? 488 : null);
      if (state === 'MERGED') assert.equal(result.items[0].dependencyParent.status, 'MERGED');
      assert.equal(result.items[1].dependencyParent, null);
    }
    assert.equal(lookups, 1);
  }
});

test('merged parents are labeled without an active edge or standalone gutter', () => {
  const parent = pr('A', 'main', { number: 42, status: 'MERGED' });
  const child = pr('B', 'A', { number: 43 });
  for (const allItems of [[parent, child], [child]]) {
    const graph = dependencyLanes([{ ...child, dependencyParent: parent }], { allItems });
    assert.equal(graph.gutter, 0);
    assert.equal(graph.rows[0].mergedParent.number, 42);
    assert.equal(graph.rows[0].externalParent, null);
    assert.equal(graph.rows[0].parentIndex, -1);
  }
  const stale = dependencyLanes([{ ...child, dependencyParent: { ...parent, status: 'OPEN' } }], { allItems: [parent, child] });
  assert.equal(stale.rows[0].mergedParent.number, 42);
  assert.equal(stale.gutter, 0);
  const stack = dependencyLanes([{ ...child, dependencyParent: parent }, pr('C', 'B', { number: 44 })]);
  assert.equal(stack.rows[0].mergedParent.number, 42);
  assert.equal(stack.rows[1].parentIndex, 0);
  assert.equal(stack.rows[0].externalParent, null);
});

test('successful merge invalidates the cached dependency parent state', async () => {
  let merged = false, lookups = 0;
  const parent = { id: 'parent', __typename: 'PullRequest', number: 42, state: 'OPEN', isDraft: false,
    author: { login: 'alice' }, headRefName: 'parent', headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    repository: { nameWithOwner: 'org/repo', defaultBranchRef: { name: 'main' }, viewerPermission: 'WRITE', squashMergeAllowed: true },
    headRepository: { nameWithOwner: 'org/repo' }, commits: { nodes: [] }, labels: { nodes: [] } };
  const child = { ...parent, id: 'child', number: 43, headRefName: 'child', baseRefName: 'parent' };
  const list = createGitHub({ getToken: async () => 'test', fetchImpl: async (_url, options) => {
    const { query } = JSON.parse(options.body);
    if (query.includes('query DependencyParents')) {
      lookups++;
      return Response.json({ data: { p0: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{ ...parent, state: merged ? 'MERGED' : 'OPEN' }] } } } });
    }
    if (query.includes('mutation')) {
      merged = true;
      return Response.json({ data: { mergePullRequest: { pullRequest: { id: parent.id, state: 'MERGED', updatedAt: new Date().toISOString() } } } });
    }
    if (query.includes('node(id:')) return Response.json({ data: { node: parent, viewer: { login: 'alice' } } });
    return Response.json({ data: { viewer: { login: 'alice' }, search: { issueCount: 1, pageInfo: {}, nodes: [child] } } });
  } });
  assert.equal((await list({ query: 'is:pr' })).items[0].dependencyParent.status, 'OPEN');
  await list.merge({ id: parent.id, headOid: parent.headRefOid, mergeMethod: 'SQUASH' });
  assert.equal((await list({ query: 'is:pr' })).items[0].dependencyParent.status, 'MERGED');
  assert.equal(lookups, 2);
});

test('unresolved non-default bases retain a label without guessing a parent PR', () => {
  const child = pr('wallet', 'merge-train/spartan', { defaultBranch: 'next' });
  const graph = dependencyLanes([child]);
  assert.equal(graph.rows[0].unloadedBase, true);
  assert.equal(graph.rows[0].lane, 0);
  assert.equal(graph.gutter, 32);
  for (const fields of [{ baseBranch: 'next' }, { baseBranch: '' }, { defaultBranch: '' }, { status: 'MERGED' },
    { dependencyParent: { id: 'parent', number: 42, status: 'MERGED' } },
    { dependencyParent: { id: 'parent', number: 42, status: 'OPEN' } }]) {
    assert.equal(dependencyLanes([{ ...child, ...fields }]).rows[0].unloadedBase, false);
  }
  const parent = pr('parent', 'next', { branch: child.baseBranch, defaultBranch: 'next' });
  assert.equal(dependencyLanes([parent, child]).rows[1].unloadedBase, false);
});
