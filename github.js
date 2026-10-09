import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const fields = `id number title url state isDraft createdAt updatedAt headRefName
  author { login } repository { nameWithOwner }
  additions deletions reviewDecision
  reviewRequests(first: 100) {
    pageInfo { hasNextPage }
    nodes { requestedReviewer {
      ... on Actor { login }
      ... on Team { slug organization { login } }
      ... on EnterpriseTeam { name }
    } }
  }
  latestReviews(first: 100) {
    pageInfo { hasNextPage }
    nodes { author { login } state }
  }
  labels(first: 10) { nodes { name } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

export class ApiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export function validateTitleUpdate(input) {
  if (!input || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 200 ||
      typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 256 ||
      /[\r\n]/.test(input.title) || typeof input.expectedTitle !== 'string') {
    throw new ApiError('Provide a PR ID, its current title, and a new single-line title (1–256 characters).', 400);
  }
  return { id: input.id, title: input.title.trim(), expectedTitle: input.expectedTitle };
}

export function validateDraftUpdate(input) {
  if (!input || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 200) {
    throw new ApiError('Provide a valid pull request ID.', 400);
  }
  return { id: input.id };
}

export function reviewersFor(pr) {
  const reviewers = new Map();
  for (const review of pr.latestReviews?.nodes ?? []) {
    const name = review?.author?.login;
    if (name && name !== pr.author?.login && review.state !== 'PENDING') {
      reviewers.set(name, { name, state: review.state });
    }
  }
  // A new request takes precedence over a previous review from the same person.
  for (const request of pr.reviewRequests?.nodes ?? []) {
    const reviewer = request?.requestedReviewer;
    const name = reviewer?.login ?? (reviewer?.slug ? `${reviewer.organization.login}/${reviewer.slug}` : reviewer?.name);
    if (name) reviewers.set(name, { name, state: 'REQUESTED' });
  }
  return [...reviewers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function createGitHub({ fetchImpl = fetch, getToken = defaultToken } = {}) {
  let token;
  async function graphql(query, variables) {
    token ||= await getToken();
    let response;
    try {
      response = await fetchImpl('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'gh-pull' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new ApiError('Could not reach GitHub. Check your connection and retry.'); }
    if (response.status === 401) {
      token = undefined;
      throw new ApiError('GitHub login expired. Run gh auth login, then retry.', 401);
    }
    if (response.status === 403 || response.status === 429) {
      throw new ApiError('GitHub denied the request or its rate limit was reached. Check your token permissions or retry later.', 429);
    }
    if (!response.ok) throw new ApiError(`GitHub returned HTTP ${response.status}. Retry shortly.`);
    const payload = await response.json();
    if (payload.errors?.length) throw new ApiError(`GitHub: ${payload.errors.map(error => error.message).join('; ')}`);
    return payload.data;
  }
  async function list({ scope = 'authored', state = 'open', cursor = null } = {}) {
    const states = { open: ['OPEN'], closed: ['CLOSED'], merged: ['MERGED'], all: ['OPEN', 'CLOSED', 'MERGED'] }[state];
    if (!states || !['authored', 'involved', 'review'].includes(scope)) throw new ApiError('Invalid filter.', 400);
    let data, connection;
    if (scope === 'authored') {
      data = await graphql(`query($cursor: String, $states: [PullRequestState!]) {
        viewer { login pullRequests(first: 50, after: $cursor, states: $states,
          orderBy: {field: UPDATED_AT, direction: DESC}) {
          totalCount pageInfo { hasNextPage endCursor } nodes { ${fields} }
        } }
      }`, { cursor, states });
      connection = data.viewer.pullRequests;
    } else {
      const qualifier = scope === 'involved' ? 'involves:@me' : 'review-requested:@me';
      const query = `is:pr ${qualifier} ${state === 'all' ? '' : `is:${state}`} sort:updated-desc`;
      data = await graphql(`query($cursor: String, $query: String!) {
        viewer { login }
        search(type: ISSUE, query: $query, first: 50, after: $cursor) {
          issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${fields} } }
        }
      }`, { cursor, query });
      connection = data.search;
    }
    return {
      viewer: data.viewer.login,
      total: connection.totalCount ?? connection.issueCount,
      limited: scope !== 'authored' && connection.issueCount > 1000,
      pageInfo: connection.pageInfo,
      items: connection.nodes.filter(pr => pr?.id).map(pr => ({
        id: pr.id, number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName ?? '',
        status: pr.state === 'OPEN' && pr.isDraft ? 'DRAFT' : pr.state,
        author: pr.author?.login ?? 'deleted-user', repo: pr.repository.nameWithOwner,
        createdAt: pr.createdAt, updatedAt: pr.updatedAt,
        additions: pr.additions, deletions: pr.deletions,
        review: pr.reviewDecision || 'NONE',
        reviewers: reviewersFor(pr),
        reviewersTruncated: Boolean(pr.reviewRequests?.pageInfo.hasNextPage || pr.latestReviews?.pageInfo.hasNextPage),
        checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? 'NONE',
        labels: pr.labels.nodes.map(label => label.name),
      })),
    };
  }

  list.updateTitle = async input => {
    const { id, title, expectedTitle } = validateTitleUpdate(input);
    const current = await graphql(`query($id: ID!) {
      viewer { login }
      node(id: $id) { __typename ... on PullRequest { id title updatedAt author { login } } }
    }`, { id });
    const pr = current.node;
    if (pr?.__typename !== 'PullRequest') throw new ApiError('Pull request not found.', 404);
    if (!pr.author?.login || pr.author.login.toLowerCase() !== current.viewer.login.toLowerCase()) {
      throw new ApiError('You can only edit titles of your own pull requests.', 403);
    }
    // An unchanged retry is safe if the first mutation succeeded but its response was lost.
    if (pr.title === title) return { id: pr.id, title: pr.title, updatedAt: pr.updatedAt };
    if (pr.title !== expectedTitle) throw new ApiError('The title changed on GitHub. Cancel this edit and refresh before editing again.', 409);
    const data = await graphql(`mutation($input: UpdatePullRequestInput!) {
      updatePullRequest(input: $input) { pullRequest { id title updatedAt } }
    }`, { input: { pullRequestId: id, title } });
    if (!data.updatePullRequest?.pullRequest) throw new ApiError('GitHub did not confirm the title update. Refresh to check its current title.');
    return data.updatePullRequest.pullRequest;
  };
  async function setDraftState(input, draft) {
    const { id } = validateDraftUpdate(input);
    const draftFields = 'id state isDraft updatedAt reviewDecision';
    const current = await graphql(`query($id: ID!) {
      viewer { login }
      node(id: $id) { __typename ... on PullRequest { ${draftFields} author { login } } }
    }`, { id });
    let pr = current.node;
    if (pr?.__typename !== 'PullRequest') throw new ApiError('Pull request not found.', 404);
    if (!pr.author?.login || pr.author.login.toLowerCase() !== current.viewer.login.toLowerCase()) {
      throw new ApiError('You can only change the draft status of your own pull requests.', 403);
    }
    if (pr.state !== 'OPEN') throw new ApiError('Only open pull requests can change draft status. Refresh to see the latest status.', 409);
    if (pr.isDraft !== draft) {
      const mutation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
      const inputType = draft ? 'ConvertPullRequestToDraftInput' : 'MarkPullRequestReadyForReviewInput';
      const data = await graphql(`mutation($input: ${inputType}!) {
        ${mutation}(input: $input) { pullRequest { ${draftFields} } }
      }`, { input: { pullRequestId: id } });
      pr = data[mutation]?.pullRequest;
      if (pr?.isDraft !== draft || pr.state !== 'OPEN') throw new ApiError('GitHub did not confirm the status change. Refresh to check its status.');
    }
    return { id: pr.id, status: draft ? 'DRAFT' : 'OPEN', updatedAt: pr.updatedAt, review: pr.reviewDecision || 'NONE' };
  }
  list.convertToDraft = input => setDraftState(input, true);
  list.markReadyForReview = input => setDraftState(input, false);
  return list;
}

async function defaultToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    const { stdout } = await exec('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 10_000 });
    if (stdout.trim()) return stdout.trim();
  } catch { /* Return actionable instructions without exposing CLI output. */ }
  throw new ApiError('Sign in with gh auth login, or set GH_TOKEN before starting the server, then retry.', 401);
}
