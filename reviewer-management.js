import { ApiError } from './github-client.js';
import { normalizePullRequest } from './pull-request.js';

export function validateReviewerChange(input) {
  if (!input || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 200 ||
      !['request', 'remove'].includes(input.action) || !['user', 'team'].includes(input.kind) ||
      typeof input.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}(?:\/[a-z0-9][a-z0-9-]{0,99})?$/i.test(input.name) ||
      (input.kind === 'team') !== input.name.includes('/')) {
    throw new ApiError('Provide a PR ID, reviewer, and request or remove action.', 400);
  }
  return { id: input.id, action: input.action, kind: input.kind, name: input.name };
}

export function createReviewerManagement({ graphql, request, ownedPullRequest, fields }) {
  const contributorCache = new Map();
  async function contributors(repo) {
    const cached = contributorCache.get(repo);
    if (cached && cached.expires > Date.now()) return cached.value;
    const path = repo.split('/').map(encodeURIComponent).join('/');
    let users;
    try { users = await request(`/repos/${path}/contributors?per_page=100`) ?? []; }
    catch (error) {
      if (error.status === 401 || error.status === 429) throw error;
      // Large histories and inaccessible contributor endpoints must not block suggestions.
      users = [];
    }
    const value = { users: users.filter(user => user.type === 'User' && user.login), limited: users.length === 100 };
    if (contributorCache.size >= 100) contributorCache.delete(contributorCache.keys().next().value);
    contributorCache.set(repo, { value, expires: Date.now() + 5 * 60_000 });
    return value;
  }
  const selection = 'id number state isDraft author { login } repository { nameWithOwner }';
  async function owned(id) {
    if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new ApiError('Provide a valid pull request ID.', 400);
    const result = await ownedPullRequest(id, selection, 'You can only manage reviewers on your own pull requests.');
    if (result.pr.state !== 'OPEN' || result.pr.isDraft) throw new ApiError('Reviewers can only be requested on open PRs that are ready for review.', 409);
    return result;
  }
  return {
    async reviewerSuggestions(id, query = '') {
      if (typeof query !== 'string' || query.length > 100) throw new ApiError('Search must be at most 100 characters.', 400);
      const { pr } = await owned(id);
      const queryText = query.trim().replace(/^@/, '');
      const repoContributors = await contributors(pr.repository.nameWithOwner);
      const candidates = repoContributors.users
        .filter(user => user.login.toLowerCase() !== pr.author.login.toLowerCase() && user.login.toLowerCase().includes(queryText.toLowerCase()))
        .map(user => ({ name: user.login, displayName: 'Repository contributor', kind: 'user' }));
      const data = await graphql(`query ReviewerSuggestions($id: ID!, $query: String!) {
        node(id: $id) { ... on PullRequest {
          suggestedReviewerActors(first: 20, query: $query) {
            pageInfo { hasNextPage } nodes { reviewer { login ... on User { id name } } }
          }
        } }
      }`, { id, query: queryText });
      const connection = data.node?.suggestedReviewerActors;
      const users = (connection?.nodes ?? []).map(n => n?.reviewer).filter(r => r?.id && r.login.toLowerCase() !== pr.author.login.toLowerCase());
      const combined = new Map(users.map(user => [user.login.toLowerCase(), { name: user.login, displayName: user.name, kind: 'user' }]));
      for (const user of candidates) if (!combined.has(user.name.toLowerCase())) combined.set(user.name.toLowerCase(), user);
      return { reviewers: [...combined.values()], limited: repoContributors.limited || Boolean(connection?.pageInfo?.hasNextPage) };
    },
    async changeReviewer(input) {
      const { id, action, kind, name } = validateReviewerChange(input);
      const { pr, viewer } = await owned(id);
      const [owner, repo] = pr.repository.nameWithOwner.split('/');
      if (kind === 'user' && name.toLowerCase() === pr.author.login.toLowerCase()) throw new ApiError('You cannot request a review from the PR author.', 400);
      if (kind === 'team' && name.split('/')[0].toLowerCase() !== owner.toLowerCase()) throw new ApiError('Choose a team from the repository’s organization.', 400);
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr.number}/requested_reviewers`;
      // Check current requests for safe retries; change only the selected reviewer.
      try {
        const current = await request(path);
        const value = kind === 'team' ? name.split('/')[1] : name;
        const exists = (kind === 'team' ? current.teams : current.users)?.some(r => (kind === 'team' ? r.slug : r.login).toLowerCase() === value.toLowerCase());
        if ((action === 'request') !== Boolean(exists)) {
          await request(path, { method: action === 'request' ? 'POST' : 'DELETE', body: { [kind === 'team' ? 'team_reviewers' : 'reviewers']: [value] } });
        }
      } catch (error) {
        if (error.status === 404) throw new ApiError('GitHub could not access this PR’s reviewers. Check repository access and token permissions.', 404);
        if (error.status === 422) throw new ApiError(action === 'request'
          ? 'GitHub could not request this reviewer. Check repository access and reviewer eligibility.'
          : 'GitHub could not remove this review request. Check repository access and the current reviewer requests.', 422);
        throw error;
      }
      const data = await graphql(`query ReviewerResult($id: ID!) { node(id: $id) { ... on PullRequest { ${fields} } } }`, { id });
      if (!data.node?.id) throw new ApiError('Could not confirm reviewer state. Refresh before trying again.');
      return normalizePullRequest(data.node, viewer);
    },
  };
}
