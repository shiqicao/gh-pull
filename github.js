import { createReviewThreadCounts } from './review-thread-counts.js';
import { repositoryScope } from './public/query.js';
import { ApiError, createGraphQLClient } from './github-client.js';
import { mergeOptions, normalizePullRequest, reviewState } from './pull-request.js';

// Preserve the service API used by the server and existing integrations.
export { ApiError } from './github-client.js';
export { mergeOptions, reviewersFor } from './pull-request.js';
const mergeFields = `viewerCanMergeAsAdmin headRefOid mergeable mergeStateStatus mergeQueue { id } stackEntry { id }
  repository { nameWithOwner viewerPermission viewerDefaultMergeMethod mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed }`;

export function validateMerge(input) {
  const { id } = validateDraftUpdate(input);
  if (!/^[a-f0-9]{40}$/i.test(input.headOid ?? '') || !['MERGE', 'SQUASH', 'REBASE'].includes(input.mergeMethod)) {
    throw new ApiError('Provide the displayed commit and merge method.', 400);
  }
  return { id, headOid: input.headOid, mergeMethod: input.mergeMethod };
}

const fields = `viewerCanClose viewerCanReopen id number title url state isDraft createdAt updatedAt headRefName baseRefName
  headRepository { nameWithOwner }
  author { login } repository { nameWithOwner defaultBranchRef { name } }
  ${mergeFields}
  additions deletions changedFiles totalCommentsCount reviewDecision
  closingIssuesReferences(first: 20) {
    totalCount pageInfo { hasNextPage }
    nodes { number title url state repository { nameWithOwner } }
  }
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
    nodes { id url author { login } state }
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

export function validateClose(input) {
  const { id } = validateDraftUpdate(input);
  const comment = input.comment ?? '';
  if (typeof comment !== 'string' || comment.length > 4000) throw new ApiError('Comment must be at most 4,000 characters.', 400);
  return { id, comment: comment.trim() };
}

export function validateReviewDismissal(input) {
  const { id } = validateDraftUpdate(input);
  if (typeof input.reviewId !== 'string' || !input.reviewId.trim() || input.reviewId.length > 200 ||
      typeof input.message !== 'string' || !input.message.trim() || input.message.trim().length > 1000) {
    throw new ApiError('Provide a review ID and a reason (1–1,000 characters).', 400);
  }
  return { id, reviewId: input.reviewId, message: input.message.trim() };
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

function dependencyQuery(batch) {
  const variables = {}, definitions = [], queries = [];
  batch.forEach(([, pr], i) => {
    const [owner, repo] = pr.repo.split('/');
    Object.assign(variables, { [`owner${i}`]: owner, [`repo${i}`]: repo, [`branch${i}`]: pr.baseBranch });
    definitions.push(`$owner${i}: String!`, `$repo${i}: String!`, `$branch${i}: String!`);
    queries.push(`p${i}: repository(owner: $owner${i}, name: $repo${i}) {
      pullRequests(headRefName: $branch${i}, states: [OPEN, CLOSED, MERGED], first: 10, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage } nodes { id number state updatedAt headRefName headRepository { nameWithOwner } }
      }
    }`);
  });
  return [`query DependencyParents(${definitions.join(', ')}) { ${queries.join('\n')} }`, variables];
}

export function createGitHub(options = {}) {
  const { getMergeAccess } = options;
  const graphql = createGraphQLClient(options);
  const withReviewThreadCounts = createReviewThreadCounts(graphql);

  async function ownedPullRequest(id, selection, deniedMessage) {
    const data = await graphql(`query($id: ID!) {
      viewer { login }
      node(id: $id) { __typename ... on PullRequest { ${selection} } }
    }`, { id });
    const pr = data.node;
    if (pr?.__typename !== 'PullRequest') throw new ApiError('Pull request not found.', 404);
    if (!pr.author?.login || pr.author.login.toLowerCase() !== data.viewer.login.toLowerCase()) {
      throw new ApiError(deniedMessage, 403);
    }
    return { pr, viewer: data.viewer.login };
  }

  async function withMergeAccess(items) {
    if (!getMergeAccess) return items;
    const repos = [...new Set(items.filter(pr => pr.canMerge || pr.mergePending).map(pr => pr.repo))];
    const access = await getMergeAccess(repos);
    return items.map(pr => access.has(pr.repo) ? { ...pr, mergeAccess: access.get(pr.repo) } : pr);
  }
  const dependencyCache = new Map();
  function cacheDependency(key, parent, prune = false) {
    if (prune && dependencyCache.size >= 256) dependencyCache.clear();
    dependencyCache.set(key, { until: Date.now() + 60_000, parent });
  }
  async function normalizeAll(nodes, viewer) {
    return withDependencyParents(await withMergeAccess(nodes.filter(pr => pr?.id).map(pr => normalizePullRequest(pr, viewer))));
  }
  async function withDependencyParents(items) {
    const candidates = new Map();
    for (const pr of items) {
      if (!['OPEN', 'DRAFT'].includes(pr.status) || !pr.defaultBranch || !pr.baseBranch || pr.baseBranch === pr.defaultBranch) continue;
      const key = JSON.stringify([pr.repo, pr.baseBranch]);
      candidates.set(key, pr);
    }
    const missing = [...candidates].filter(([key]) => (dependencyCache.get(key)?.until ?? 0) < Date.now());
    for (let offset = 0; offset < missing.length; offset += 20) {
      const batch = missing.slice(offset, offset + 20), query = dependencyQuery(batch);
      try {
        const data = await graphql(...query);
        batch.forEach(([key, pr], i) => {
          const connection = data[`p${i}`]?.pullRequests;
          const matches = (connection?.nodes ?? []).filter(n => n.headRefName === pr.baseBranch && n.headRepository?.nameWithOwner?.toLowerCase() === pr.repo.toLowerCase());
          const open = matches.filter(n => n.state === 'OPEN');
          const match = !connection?.pageInfo?.hasNextPage && (open.length === 1 ? open[0] : !open.length && matches.length === 1 ? matches[0] : null);
          cacheDependency(key, match ? { id: match.id, number: match.number, status: match.state, ...(match.updatedAt ? { updatedAt: match.updatedAt } : {}) } : null, true);
        });
      } catch {
        // The graph is supplementary: a lookup failure must not hide loaded PRs.
        for (const [key] of batch) cacheDependency(key, null);
      }
    }
    return items.map(pr => ({ ...pr, dependencyParent: dependencyCache.get(JSON.stringify([pr.repo, pr.baseBranch]))?.parent ?? null }));
  }
  async function list({ scope = 'authored', state = 'open', cursor = null, query: customQuery } = {}) {
    const states = { open: ['OPEN'], closed: ['CLOSED'], merged: ['MERGED'], all: ['OPEN', 'CLOSED', 'MERGED'] }[state];
    if (!states || !['authored', 'involved', 'review'].includes(scope)) throw new ApiError('Invalid filter.', 400);
    let data, connection;
    if (customQuery === undefined && scope === 'authored') {
      data = await graphql(`query($cursor: String, $states: [PullRequestState!]) {
        viewer { login pullRequests(first: 50, after: $cursor, states: $states,
          orderBy: {field: UPDATED_AT, direction: DESC}) {
          totalCount pageInfo { hasNextPage endCursor } nodes { ${fields} }
        } }
      }`, { cursor, states });
      connection = data.viewer.pullRequests;
    } else {
      const qualifier = scope === 'involved' ? 'involves:@me' : 'review-requested:@me';
      const query = customQuery ?? `is:pr ${qualifier} ${state === 'all' ? '' : `is:${state}`} sort:updated-desc`;
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
      limited: connection.issueCount > 1000,
      pageInfo: connection.pageInfo,
      items: await normalizeAll(connection.nodes, data.viewer.login),
    };
  }

  list.viewer = async () => (await graphql('query SavedViewsViewer { viewer { login } }')).viewer.login;

  list.repositories = async query => {
    const scope = repositoryScope(query);
    async function discover(people) {
      const repos = new Set();
      let cursor = null, limited = false;
      for (let page = 0; page < 10; page++) {
        const data = await graphql(`query RepositorySuggestions($query: String!, $cursor: String) {
          search(type: ISSUE, query: $query, first: 100, after: $cursor) {
            issueCount pageInfo { hasNextPage endCursor }
            nodes { ... on PullRequest { repository { nameWithOwner } } }
          }
        }`, { query: `is:pr ${people} sort:updated-desc`, cursor });
        const connection = data.search;
        for (const pr of connection.nodes ?? []) if (pr?.repository?.nameWithOwner) repos.add(pr.repository.nameWithOwner);
        limited = connection.issueCount > 1000 || Boolean(connection.pageInfo.hasNextPage);
        if (!connection.pageInfo.hasNextPage) break;
        const next = connection.pageInfo.endCursor;
        if (!next || next === cursor) break;
        cursor = next;
      }
      return { repositories: [...repos].sort(), limited };
    }
    let result = await discover(scope), source = 'scope';
    if (!result.repositories.length && scope !== 'involves:@me') {
      result = await discover('involves:@me'); source = 'me';
    }
    if (!result.repositories.length) {
      // New accounts may have repositories but no PR activity yet.
      const repos = new Set();
      let cursor = null;
      for (let page = 0; page < 10; page++) {
        const data = await graphql(`query ViewerRepositorySuggestions($cursor: String) {
          viewer { repositories(first: 100, after: $cursor,
            affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: UPDATED_AT, direction: DESC}) {
              pageInfo { hasNextPage endCursor } nodes { nameWithOwner }
          } }
        }`, { cursor });
        const connection = data.viewer.repositories;
        for (const repo of connection.nodes ?? []) if (repo?.nameWithOwner) repos.add(repo.nameWithOwner);
        result.limited = Boolean(connection.pageInfo.hasNextPage);
        if (!connection.pageInfo.hasNextPage) break;
        const next = connection.pageInfo.endCursor;
        if (!next || next === cursor) break;
        cursor = next;
      }
      result.repositories = [...repos].sort(); source = 'me';
    }
    return { ...result, source };
  };

  // Fetch only active PRs between full searches, using their stable node IDs.
  list.status = async ids => {
    const data = await graphql(`query($ids: [ID!]!) {
      viewer { login }
      nodes(ids: $ids) { ... on PullRequest { ${fields} } }
    }`, { ids });
    return { items: await normalizeAll(data.nodes, data.viewer.login) };
  };

  list.reviewCounts = async ids => {
    const data = await graphql(`query ReviewCountVersions($ids: [ID!]!) {
      nodes(ids: $ids) { ... on PullRequest { id updatedAt totalCommentsCount } }
    }`, { ids });
    return { items: await withReviewThreadCounts(data.nodes.filter(pr => pr?.id).map(pr => ({
      id: pr.id, updatedAt: pr.updatedAt, commentCount: pr.totalCommentsCount,
    }))) };
  };

  list.mergeReadiness = async ids => {
    const data = await graphql(`query($ids: [ID!]!) {
      viewer { login }
      nodes(ids: $ids) { ... on PullRequest {
        id state isDraft author { login } reviewDecision ${mergeFields}
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      } }
    }`, { ids });
    return { items: await withMergeAccess(data.nodes.filter(pr => pr?.id).map(pr => ({ id: pr.id, repo: pr.repository?.nameWithOwner, ...mergeOptions(pr, data.viewer.login), review: reviewState(pr) }))) };
  };

  list.merge = async input => {
    const { id, headOid, mergeMethod } = validateMerge(input);
    const { pr, viewer } = await ownedPullRequest(id, `id state isDraft author { login } ${mergeFields}
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`, 'You can only merge your own pull requests.');
    const readiness = mergeOptions(pr, viewer);
    if (!readiness.canMerge) throw new ApiError('This PR is no longer ready to merge. Refresh to see its current status.', 409);
    if (pr.headRefOid !== headOid) throw new ApiError('New commits were pushed. Refresh and review the changes before merging.', 409);
    if (!readiness.mergeMethods.includes(mergeMethod)) throw new ApiError('This merge method is no longer enabled for the repository. Refresh and choose another method.', 409);
    if (getMergeAccess) {
      const access = (await getMergeAccess([pr.repository.nameWithOwner])).get(pr.repository.nameWithOwner);
      if (!access?.allowed) throw new ApiError(access?.message || 'Could not verify app access. Refresh to try again.', 403);
    }
    const data = await graphql(`mutation($input: MergePullRequestInput!) {
      mergePullRequest(input: $input) { pullRequest { id state updatedAt } }
    }`, { input: { pullRequestId: id, expectedHeadOid: headOid, mergeMethod } });
    const merged = data.mergePullRequest?.pullRequest;
    if (merged?.state !== 'MERGED') throw new ApiError('GitHub did not confirm the merge. Refresh to check its status.');
    dependencyCache.clear();
    return { id: merged.id, status: 'MERGED', updatedAt: merged.updatedAt, canMerge: false };
  };

  async function setClosed(input, closed) {
    const { id, comment = '' } = closed ? validateClose(input) : validateDraftUpdate(input);
    let { pr, viewer } = await ownedPullRequest(id, fields, 'You can only close or reopen your own pull requests.');
    const expected = closed ? 'CLOSED' : 'OPEN';
    if (pr.state === 'MERGED') throw new ApiError('Merged pull requests cannot be closed or reopened.', 409);
    if (pr.state === expected) {
      dependencyCache.clear();
      return { ...normalizePullRequest(pr, viewer), ...(comment ? { warning: 'This PR was already closed. No additional comment was posted.' } : {}) };
    }
    if (!(closed ? pr.viewerCanClose : pr.viewerCanReopen)) throw new ApiError('GitHub does not allow this action on this pull request.', 403);
    const name = closed ? 'closePullRequest' : 'reopenPullRequest';
    const type = closed ? 'ClosePullRequestInput' : 'ReopenPullRequestInput';
    const data = await graphql(`mutation($input: ${type}!) { ${name}(input: $input) { pullRequest { ${fields} } } }`, { input: { pullRequestId: id } });
    pr = data[name]?.pullRequest;
    if (pr?.state !== expected) throw new ApiError('GitHub did not confirm the status change. Refresh to check its status.');
    dependencyCache.clear();
    let warning;
    if (closed && comment) {
      try {
        const posted = await graphql(`mutation($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id } } } }`, { input: { subjectId: id, body: comment } });
        if (!posted.addComment?.commentEdge?.node?.id) throw new Error('Unconfirmed comment');
      } catch { warning = 'PR closed, but the comment could not be confirmed. Check GitHub before posting it again.'; }
    }
    return { ...normalizePullRequest(pr, viewer), ...(warning ? { warning } : {}) };
  }
  list.closePull = input => setClosed(input, true);
  list.reopenPull = input => setClosed(input, false);

  list.dismissReview = async input => {
    const { id, reviewId, message } = validateReviewDismissal(input);
    const data = await graphql(`query($id: ID!) {
      viewer { login }
      node(id: $id) { ... on PullRequestReview {
        id state author { login } pullRequest { id state }
      } }
    }`, { id: reviewId });
    const review = data.node;
    if (!review || review.pullRequest?.id !== id) throw new ApiError('Review not found on this pull request.', 404);
    if (review.author?.login?.toLowerCase() !== data.viewer.login.toLowerCase()) {
      throw new ApiError('You can only revoke your own approval.', 403);
    }
    if (review.pullRequest.state !== 'OPEN' || review.state !== 'APPROVED') {
      throw new ApiError('This approval is no longer active on an open PR. Refresh to see its status.', 409);
    }
    const result = await graphql(`mutation($input: DismissPullRequestReviewInput!) {
      dismissPullRequestReview(input: $input) { pullRequestReview {
        state pullRequest { ${fields} }
      } }
    }`, { input: { pullRequestReviewId: reviewId, message } });
    const dismissed = result.dismissPullRequestReview?.pullRequestReview;
    if (dismissed?.state !== 'DISMISSED' || !dismissed.pullRequest) {
      throw new ApiError('GitHub did not confirm the revocation. Refresh to check its status.');
    }
    return normalizePullRequest(dismissed.pullRequest, data.viewer.login);
  };

  list.updateTitle = async input => {
    const { id, title, expectedTitle } = validateTitleUpdate(input);
    const { pr } = await ownedPullRequest(id, 'id title updatedAt author { login }', 'You can only edit titles of your own pull requests.');
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
    const draftFields = 'id state isDraft updatedAt reviewDecision viewerCanMergeAsAdmin';
    let { pr } = await ownedPullRequest(id, `${draftFields} author { login }`, 'You can only change the draft status of your own pull requests.');
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
    return { id: pr.id, status: draft ? 'DRAFT' : 'OPEN', updatedAt: pr.updatedAt, review: reviewState(pr) };
  }
  list.convertToDraft = input => setDraftState(input, true);
  list.markReadyForReview = input => setDraftState(input, false);
  return list;
}
