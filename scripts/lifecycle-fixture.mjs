// Local-only sample PRs. No GitHub client or credentials are used.
export function lifecycleFixture() {
  let revision = 1;
  let items = [1, 2].map(number => ({
    id: `demo-${number}`, number, title: number === 1 ? 'Improve repository search' : 'Add keyboard shortcuts', repo: 'demo/dashboard',
    url: `https://github.com/demo/dashboard/pull/${number}`, author: 'alice', status: 'OPEN', checks: 'SUCCESS', review: 'NONE',
    canClose: true, canReopen: false, labels: [], reviewers: [], additions: 24, deletions: 8,
    branch: `feature/${number}`, baseBranch: number === 2 ? 'feature/1' : 'main', defaultBranch: 'main', branchRepository: 'demo/dashboard',
    dependencyParent: number === 2 ? { id: 'demo-1', number: 1, status: 'OPEN' } : null,
    createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T01:00:00Z',
  }));
  const list = async ({ query = '' } = {}) => ({ viewer: 'alice', total: items.length,
    items: items.filter(pr => !query.includes('is:open') || ['OPEN', 'DRAFT'].includes(pr.status)), pageInfo: { hasNextPage: false } });
  list.status = async () => ({ items });
  list.mergeReadiness = async () => ({ items: [] });
  function update(id, status) {
    const updatedAt = `2026-10-20T${String(++revision).padStart(2, '0')}:00:00Z`;
    items = items.map(pr => ({ ...pr, ...(pr.id === id ? { status, canClose: status !== 'CLOSED', canReopen: status === 'CLOSED', updatedAt } : {}),
      ...(pr.dependencyParent?.id === id ? { dependencyParent: { ...pr.dependencyParent, status, updatedAt } } : {}) }));
    return items.find(pr => pr.id === id);
  }
  list.closePull = async ({ id }) => update(id, 'CLOSED');
  list.reopenPull = async ({ id }) => update(id, 'OPEN');
  list.convertToDraft = async ({ id }) => update(id, 'DRAFT');
  list.markReadyForReview = async ({ id }) => update(id, 'OPEN');
  return list;
}
