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
  const hasConflicts = pr.state === 'OPEN' && (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY');
  return { canMerge, mergePending, hasConflicts, mergeMethods: methods, headOid: pr.headRefOid, mergeMethod: methods.includes(repo.viewerDefaultMergeMethod) ? repo.viewerDefaultMergeMethod : methods[0] };
}

function checkCountsFor(pr) {
  const contexts = pr.commits?.nodes[0]?.commit.statusCheckRollup?.contexts;
  if (!contexts) return null;
  const counts = [...(contexts.checkRunCountsByState ?? []), ...(contexts.statusContextCountsByState ?? [])];
  return {
    passed: counts.filter(count => count.state === 'SUCCESS').reduce((sum, count) => sum + count.count, 0),
    total: contexts.totalCount,
  };
}

export function reviewersFor(pr, viewerLogin) {
  const reviewers = new Map();
  for (const review of pr.latestReviews?.nodes ?? []) {
    const name = review?.author?.login;
    if (name && name !== pr.author?.login && review.state !== 'PENDING') {
      reviewers.set(name, { name, state: review.state, ...(review.id ? {
        reviewId: review.id, reviewUrl: review.url,
        canRevoke: review.state === 'APPROVED' && pr.state === 'OPEN' &&
          name.toLowerCase() === viewerLogin?.toLowerCase() &&
          ['WRITE', 'MAINTAIN', 'ADMIN'].includes(pr.repository?.viewerPermission),
      } : {}) });
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

// GitHub reports repository review requirements even when this viewer can
// bypass them. Keep that distinction in presentation, never in merge policy.
export function reviewState(pr) {
  return pr.reviewDecision === 'REVIEW_REQUIRED' && pr.viewerCanMergeAsAdmin === true
    ? 'REVIEW_BYPASS_AVAILABLE' : pr.reviewDecision || 'NONE';
}

export function normalizePullRequest(pr, viewerLogin) {
  return {
    ...mergeOptions(pr, viewerLogin),
    canClose: pr.state === 'OPEN' && pr.viewerCanClose === true && pr.author?.login?.toLowerCase() === viewerLogin?.toLowerCase(),
    canReopen: pr.state === 'CLOSED' && pr.viewerCanReopen === true && pr.author?.login?.toLowerCase() === viewerLogin?.toLowerCase(),
    id: pr.id, number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName ?? '',
    defaultBranch: pr.repository.defaultBranchRef?.name ?? '',
    baseBranch: pr.baseRefName ?? '', branchRepository: pr.headRepository?.nameWithOwner ?? null,
    status: pr.state === 'OPEN' && pr.isDraft ? 'DRAFT' : pr.state,
    author: pr.author?.login ?? 'deleted-user', repo: pr.repository.nameWithOwner,
    createdAt: pr.createdAt, updatedAt: pr.updatedAt,
    additions: pr.additions, deletions: pr.deletions,
    changedFiles: pr.changedFiles ?? null,
    commentCount: pr.totalCommentsCount ?? null,
    closingIssues: (pr.closingIssuesReferences?.nodes ?? []).filter(Boolean).map(issue => ({
      number: issue.number, title: issue.title, url: issue.url, state: issue.state, repo: issue.repository.nameWithOwner,
    })),
    closingIssueCount: pr.closingIssuesReferences?.totalCount ?? 0,
    closingIssuesTruncated: Boolean(pr.closingIssuesReferences?.pageInfo.hasNextPage),
    review: reviewState(pr),
    reviewers: reviewersFor(pr, viewerLogin),
    reviewersTruncated: Boolean(pr.reviewRequests?.pageInfo.hasNextPage || pr.latestReviews?.pageInfo.hasNextPage),
    checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? 'NONE',
    checkCounts: checkCountsFor(pr),
    labels: pr.labels.nodes.map(label => label.name),
  };
}
