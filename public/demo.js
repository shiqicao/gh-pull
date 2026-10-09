// Fictional data only. This client never calls GitHub or the local API.
export function createDemoClient(now = Date.now()) {
  const viewer = 'alex';
  const base = Math.floor(now / 60_000) * 60_000;
  const ago = minutes => new Date(base - minutes * 60_000).toISOString();
  const samples = [
    ['web', 248, 'Add keyboard shortcuts to the command menu', 'alex', 'OPEN', 'SUCCESS', 'APPROVED', 'feat/command-menu', 12, 184, 32, [['maya', 'APPROVED'], ['noah', 'APPROVED']], ['accessibility']],
    ['web', 245, 'Fix scroll position when switching projects', 'maya', 'OPEN', 'FAILURE', 'CHANGES_REQUESTED', 'fix/project-scroll', 48, 42, 18, [['alex', 'CHANGES_REQUESTED'], ['riley', 'REQUESTED']], []],
    ['web', 239, 'Explore a compact layout for the activity feed', 'alex', 'DRAFT', 'PENDING', 'NONE', 'design/compact-feed', 145, 276, 94, [], ['design']],
    ['api', 183, 'Add cursor pagination to the events endpoint', 'noah', 'OPEN', 'SUCCESS', 'REVIEW_REQUIRED', 'feat/events-pagination', 25, 312, 47, [['alex', 'REQUESTED'], ['zoe', 'APPROVED']], ['enhancement']],
    ['api', 179, 'Handle expired sessions without losing form data', 'zoe', 'MERGED', 'SUCCESS', 'APPROVED', 'fix/session-refresh', 1320, 96, 23, [['maya', 'APPROVED']], []],
    ['infra', 91, 'Cache dependencies across preview builds', 'riley', 'OPEN', 'FAILURE', 'REVIEW_REQUIRED', 'ci/preview-cache', 210, 63, 11, [['sam', 'REQUESTED'], ['alex', 'COMMENTED']], ['ci']],
    ['infra', 86, 'Remove the legacy staging deployment', 'sam', 'CLOSED', 'NONE', 'NONE', 'cleanup/legacy-staging', 2880, 8, 152, [['riley', 'COMMENTED']], []],
  ];
  const items = samples.map(([repo, number, title, author, status, checks, review, branch, minutes, additions, deletions, reviewers, labels]) => ({
    id: `demo-${repo}-${number}`, repo: `orbit-demo/${repo}`, number, title, author, status, checks, review, branch,
    url: `https://github.com/orbit-demo/${repo}/pull/${number}`,
    createdAt: ago(minutes + 4320), updatedAt: ago(minutes), additions, deletions, labels,
    reviewers: reviewers.map(([name, state]) => ({ name, state })), reviewersTruncated: false,
  }));
  const initialViewed = Object.fromEntries(items.filter(pr => ['MERGED', 'CLOSED'].includes(pr.status)).map(pr => [pr.id, Date.parse(pr.updatedAt)]));
  const reply = (body, status = 200) => Response.json(body, { status });

  return {
    initialViewed,
    async request(path, options = {}) {
      const url = new URL(path, 'http://demo.local');
      if (url.pathname === '/api/pulls' && (!options.method || options.method === 'GET')) {
        const scope = url.searchParams.get('scope') || 'involved';
        const state = url.searchParams.get('state') || 'all';
        const selected = items.filter(pr => {
          const matchesScope = scope === 'authored' ? pr.author === viewer : scope === 'review' ? pr.reviewers.some(person => person.name === viewer && person.state === 'REQUESTED') : true;
          const matchesState = state === 'all' || (state === 'open' ? ['OPEN', 'DRAFT'].includes(pr.status) : pr.status.toLowerCase() === state);
          return matchesScope && matchesState;
        });
        return reply({ viewer, items: selected, total: selected.length, limited: false, pageInfo: { hasNextPage: false, endCursor: null } });
      }
      if (options.method !== 'PATCH' || !['/api/pulls/title', '/api/pulls/draft', '/api/pulls/ready'].includes(url.pathname)) return reply({ error: 'Unknown demo action.' }, 404);
      let input;
      try { input = JSON.parse(options.body); } catch { return reply({ error: 'Invalid demo request.' }, 400); }
      const pr = items.find(pr => pr.id === input?.id);
      if (!pr) return reply({ error: 'Demo PR not found.' }, 404);
      if (pr.author !== viewer) return reply({ error: 'You can only edit your own demo PRs.' }, 403);
      if (url.pathname === '/api/pulls/title') {
        if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 256 || /[\r\n]/.test(input.title)) return reply({ error: 'Enter a single-line title of 1–256 characters.' }, 400);
        if (pr.title !== input.expectedTitle && pr.title !== input.title.trim()) return reply({ error: 'The demo title changed. Cancel and refresh before editing again.' }, 409);
        pr.title = input.title.trim();
      } else {
        if (!['OPEN', 'DRAFT'].includes(pr.status)) return reply({ error: 'This demo PR is closed.' }, 409);
        pr.status = url.pathname === '/api/pulls/draft' ? 'DRAFT' : 'OPEN';
        pr.review = pr.status === 'DRAFT' ? 'NONE' : 'REVIEW_REQUIRED';
      }
      pr.updatedAt = new Date().toISOString();
      return reply({ id: pr.id, title: pr.title, status: pr.status, updatedAt: pr.updatedAt, review: pr.review });
    },
  };
}
