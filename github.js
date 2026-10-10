import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const mergeFields = `headRefOid mergeable mergeStateStatus mergeQueue { id } stackEntry { id }
  repository { nameWithOwner viewerPermission viewerDefaultMergeMethod mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed }`;

export function mergeOptions(pr, viewerLogin) {
  const repo = pr.repository ?? {};
  const methods = [['MERGE', repo.mergeCommitAllowed], ['SQUASH', repo.squashMergeAllowed], ['REBASE', repo.rebaseMergeAllowed]]
    .filter(([, allowed]) => allowed).map(([method]) => method);
  const checks = pr.commits?.nodes[0]?.commit.statusCheckRollup?.state;
  // Review decisions can remain REVIEW_REQUIRED on a CLEAN PR; GitHub's merge
  // status determines whether reviews actually block the merge.
  const canMerge = Boolean(viewerLogin && pr.author?.login && pr.author.login.toLowerCase() === viewerLogin.toLowerCase()) && pr.state === 'OPEN' && pr.isDraft === false && pr.mergeable === 'MERGEABLE' &&
    ['CLEAN', 'HAS_HOOKS'].includes(pr.mergeStateStatus) && !pr.mergeQueue && !pr.stackEntry &&
    ['WRITE', 'MAINTAIN', 'ADMIN'].includes(repo.viewerPermission) &&
    (!checks || checks === 'SUCCESS') && Boolean(pr.headRefOid) && methods.length > 0;
  const mergePending = Boolean(viewerLogin && pr.author?.login?.toLowerCase() === viewerLogin.toLowerCase() && pr.state === 'OPEN' && !pr.isDraft &&
    !pr.mergeQueue && !pr.stackEntry && ['WRITE', 'MAINTAIN', 'ADMIN'].includes(repo.viewerPermission) && methods.length &&
    (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN'));
  return { canMerge, mergePending, headOid: pr.headRefOid, mergeMethod: methods.includes(repo.viewerDefaultMergeMethod) ? repo.viewerDefaultMergeMethod : methods[0] };
}

export function validateMerge(input) {
  const { id } = validateDraftUpdate(input);
  if (!/^[a-f0-9]{40}$/i.test(input.headOid ?? '') || !['MERGE', 'SQUASH', 'REBASE'].includes(input.mergeMethod)) {
    throw new ApiError('Provide the displayed commit and merge method.', 400);
  }
  return { id, headOid: input.headOid, mergeMethod: input.mergeMethod };
}

const fields = `id number title url state isDraft createdAt updatedAt headRefName
  author { login } repository { nameWithOwner }
  ${mergeFields}
  additions deletions totalCommentsCount reviewDecision
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
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state
    contexts {
      totalCount
      checkRunCountsByState { state count }
      statusContextCountsByState { state count }
    }
  } } } }`;

function checkCountsFor(pr) {
  const contexts = pr.commits?.nodes[0]?.commit.statusCheckRollup?.contexts;
  if (!contexts) return null;
  const counts = [...(contexts.checkRunCountsByState ?? []), ...(contexts.statusContextCountsByState ?? [])];
  return {
    passed: counts.filter(count => count.state === 'SUCCESS').reduce((sum, count) => sum + count.count, 0),
    total: contexts.totalCount,
  };
}

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

export function createGitHub({ fetchImpl = fetch, getToken = defaultToken, cacheToken = true, getMergeAccess, authError = 'GitHub login expired. Run gh auth login, then retry.' } = {}) {
  let token;
  async function graphql(query, variables) {
    if (!cacheToken || !token) token = await getToken();
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
      throw new ApiError(authError, 401);
    }
    if (response.status === 403 || response.status === 429) {
      throw new ApiError('GitHub denied the request or its rate limit was reached. Check your token permissions or retry later.', 429);
    }
    if (!response.ok) throw new ApiError(`GitHub returned HTTP ${response.status}. Retry shortly.`);
    const payload = await response.json();
    if (payload.errors?.length) throw new ApiError(`GitHub: ${payload.errors.map(error => error.message).join('; ')}`);
    return payload.data;
  }
  async function withMergeAccess(items) {
    if (!getMergeAccess) return items;
    const repos = [...new Set(items.filter(pr => pr.canMerge || pr.mergePending).map(pr => pr.repo))];
    const access = await getMergeAccess(repos);
    return items.map(pr => access.has(pr.repo) ? { ...pr, mergeAccess: access.get(pr.repo) } : pr);
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
      items: await withMergeAccess(connection.nodes.filter(pr => pr?.id).map(pr => ({
        ...mergeOptions(pr, data.viewer.login),
        id: pr.id, number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName ?? '',
        status: pr.state === 'OPEN' && pr.isDraft ? 'DRAFT' : pr.state,
        author: pr.author?.login ?? 'deleted-user', repo: pr.repository.nameWithOwner,
        createdAt: pr.createdAt, updatedAt: pr.updatedAt,
        additions: pr.additions, deletions: pr.deletions,
        commentCount: pr.totalCommentsCount ?? null,
        review: pr.reviewDecision || 'NONE',
        reviewers: reviewersFor(pr),
        reviewersTruncated: Boolean(pr.reviewRequests?.pageInfo.hasNextPage || pr.latestReviews?.pageInfo.hasNextPage),
        checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? 'NONE',
        checkCounts: checkCountsFor(pr),
        labels: pr.labels.nodes.map(label => label.name),
      }))),
    };
  }

  list.mergeReadiness = async ids => {
    const data = await graphql(`query($ids: [ID!]!) {
      viewer { login }
      nodes(ids: $ids) { ... on PullRequest {
        id state isDraft author { login } reviewDecision ${mergeFields}
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      } }
    }`, { ids });
    return { items: await withMergeAccess(data.nodes.filter(pr => pr?.id).map(pr => ({ id: pr.id, repo: pr.repository?.nameWithOwner, ...mergeOptions(pr, data.viewer.login) }))) };
  };

  list.merge = async input => {
    const { id, headOid, mergeMethod } = validateMerge(input);
    const current = await graphql(`query($id: ID!) {
      viewer { login }
      node(id: $id) { __typename ... on PullRequest { ${fields} } }
    }`, { id });
    const pr = current.node;
    if (pr?.__typename !== 'PullRequest') throw new ApiError('Pull request not found.', 404);
    if (!pr.author?.login || pr.author.login.toLowerCase() !== current.viewer.login.toLowerCase()) {
      throw new ApiError('You can only merge your own pull requests.', 403);
    }
    const readiness = mergeOptions(pr, current.viewer.login);
    if (!readiness.canMerge) throw new ApiError('This PR is no longer ready to merge. Refresh to see its current status.', 409);
    if (pr.headRefOid !== headOid) throw new ApiError('New commits were pushed. Refresh and review the changes before merging.', 409);
    if (readiness.mergeMethod !== mergeMethod) throw new ApiError('The preferred merge method changed. Refresh before merging.', 409);
    if (getMergeAccess) {
      const access = (await getMergeAccess([pr.repository.nameWithOwner])).get(pr.repository.nameWithOwner);
      if (!access?.allowed) throw new ApiError(access?.message || 'Could not verify app access. Refresh to try again.', 403);
    }
    const data = await graphql(`mutation($input: MergePullRequestInput!) {
      mergePullRequest(input: $input) { pullRequest { id state updatedAt } }
    }`, { input: { pullRequestId: id, expectedHeadOid: headOid, mergeMethod } });
    const merged = data.mergePullRequest?.pullRequest;
    if (merged?.state !== 'MERGED') throw new ApiError('GitHub did not confirm the merge. Refresh to check its status.');
    return { id: merged.id, status: 'MERGED', updatedAt: merged.updatedAt, canMerge: false };
  };

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
