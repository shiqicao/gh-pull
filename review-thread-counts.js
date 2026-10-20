// Resolution lookups stay out of the main PR query and mutation preflight.
// Cache per GitHub client/account; refresh at most once a minute per PR version.
export function createReviewThreadCounts(graphql, { now = Date.now } = {}) {
  const cache = new Map();
  async function fetchCounts(id) {
    let cursor = null, resolved = 0, seen = 0, total;
    const cursors = new Set();
    for (let page = 0; page < 10; page++) {
      const data = await graphql(`query ReviewThreadCounts($id: ID!, $cursor: String) {
        node(id: $id) { ... on PullRequest {
          reviewThreads(first: 100, after: $cursor) {
            totalCount pageInfo { hasNextPage endCursor } nodes { isResolved }
          }
        } }
      }`, { id, cursor });
      const threads = data.node?.reviewThreads;
      if (!threads || !Number.isInteger(threads.totalCount) || !Array.isArray(threads.nodes) ||
          (total !== undefined && total !== threads.totalCount) || threads.nodes.some(node => typeof node?.isResolved !== 'boolean')) return null;
      total = threads.totalCount;
      resolved += threads.nodes.filter(node => node.isResolved).length; seen += threads.nodes.length;
      if (!threads.pageInfo?.hasNextPage) return seen === total ? { resolved, total } : null;
      cursor = threads.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor)) return null;
      cursors.add(cursor);
    }
    return null; // Never label a partial result as an exact resolved/total count.
  }
  return async function withCounts(items) {
    const result = [...items]; let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
      while (index < items.length) {
        const i = index++, pr = items[i];
        if (!Number.isInteger(pr.commentCount)) { result[i] = { ...pr, reviewThreadCounts: null }; continue; }
        if (pr.commentCount === 0) { result[i] = { ...pr, reviewThreadCounts: { resolved: 0, total: 0 } }; continue; }
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
