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
      const data = await graphql(`query ReviewerSuggestions($id: ID!, $query: String!) {
        node(id: $id) { ... on PullRequest {
          suggestedReviewerActors(first: 20, query: $query) {
            pageInfo { hasNextPage } nodes { reviewer { login ... on User { id name } } }
          }
        } }
      }`, { id, query: query.trim() });
      const connection = data.node?.suggestedReviewerActors;
      const users = (connection?.nodes ?? []).map(n => n?.reviewer).filter(r => r?.id && r.login.toLowerCase() !== pr.author.login.toLowerCase());
      return { reviewers: users.map(r => ({ name: r.login, displayName: r.name, kind: 'user' })), limited: Boolean(connection?.pageInfo?.hasNextPage) };
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
