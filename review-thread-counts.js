// Resolution lookups stay out of the main PR query and mutation preflight.
// Cache per GitHub client/account; refresh at most once a minute per PR version.
export function createReviewThreadCounts(graphql, { now = Date.now } = {}) {
  const cache = new Map();
  async function fetchCounts(id) {
    let cursor = null, resolved = 0, unresolved = 0, seen = 0, total;
    const cursors = new Set();
    for (let page = 0; page < 10; page++) {
      const data = await graphql(`query ReviewThreadCounts($id: ID!, $cursor: String) {
        node(id: $id) { ... on PullRequest {
          author { login }
          reviewThreads(first: 100, after: $cursor) {
            totalCount pageInfo { hasNextPage endCursor } nodes {
              isResolved comments(first: 1) { totalCount nodes { author { login } } }
            }
          }
        } }
      }`, { id, cursor });
      const threads = data.node?.reviewThreads;
      if (!threads || !Number.isInteger(threads.totalCount) || !Array.isArray(threads.nodes) ||
          (total !== undefined && total !== threads.totalCount) || threads.nodes.some(node => typeof node?.isResolved !== 'boolean')) return null;
      total = threads.totalCount;
      const author = data.node.author?.login?.toLowerCase();
      for (const thread of threads.nodes) {
        if (thread.isResolved) { resolved++; continue; }
        const comments = thread.comments;
        if (!Number.isInteger(comments?.totalCount) || comments.totalCount < 1 ||
            !Array.isArray(comments.nodes) || comments.nodes.length !== 1) return null;
        const starter = comments.nodes[0]?.author?.login?.toLowerCase();
        // Unknown/deleted authors are never assumed to be the same person.
        if (!(author && starter === author && comments.totalCount === 1)) unresolved++;
      }
      seen += threads.nodes.length;
      if (!threads.pageInfo?.hasNextPage) return seen === total ? { resolved, unresolved, total } : null;
      cursor = threads.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor)) return null;
      cursors.add(cursor);
    }
    return null; // Never label a partial result as exact thread counts.
  }
  return async function withCounts(items) {
    const result = [...items]; let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
      while (index < items.length) {
        const i = index++, pr = items[i];
        if (!Number.isInteger(pr.commentCount)) { result[i] = { ...pr, reviewThreadCounts: null }; continue; }
        if (pr.commentCount === 0) { result[i] = { ...pr, reviewThreadCounts: { resolved: 0, unresolved: 0, total: 0 } }; continue; }
        const key = `${pr.id}:${pr.updatedAt}`;
        let entry = cache.get(key);
        if (!entry || entry.until <= now()) {
          entry = { until: Infinity, promise: fetchCounts(pr.id).catch(() => null) };
          cache.set(key, entry);
          entry.promise.finally(() => { entry.until = now() + 60_000; });
          if (cache.size > 500) cache.delete(cache.keys().next().value);
        }
        result[i] = { ...pr, reviewThreadCounts: await entry.promise };
      }
    }));
    return result;
  };
}
