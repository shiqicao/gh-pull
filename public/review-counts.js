// Separate, bounded background requests. Neither list rendering nor status polls
// wait for this queue. Only counts for the current account and PR version apply.
export function createReviewCountsLoader({ fetchCounts, onCounts, now = Date.now }) {
  const cache = new Map(), pending = new Map();
  let desired = new Map(), account = '';
  function apply(key, entry) {
    const pr = desired.get(key);
    if (pr) onCounts(pr.id, pr.updatedAt, entry.counts);
  }
  function pump() {
    for (const [key, pr] of desired) {
      if (pending.size >= 4) break;
      if (pending.has(key) || (cache.get(key)?.until ?? 0) > now()) continue;
      const controller = new AbortController();
      pending.set(key, controller);
      Promise.resolve().then(() => fetchCounts(pr.id, controller.signal)).then(data => {
        if (controller.signal.aborted) return;
        const result = data.items?.find(item => item.id === pr.id && item.updatedAt === pr.updatedAt);
        const entry = { counts: result?.reviewThreadCounts ?? null, until: now() + 60_000 };
        cache.set(key, entry); apply(key, entry);
      }).catch(() => {
        if (controller.signal.aborted) return;
        const entry = { counts: null, until: now() + 60_000 };
        cache.set(key, entry); apply(key, entry);
      }).finally(() => {
        pending.delete(key);
        if (cache.size > 500) cache.delete(cache.keys().next().value);
        pump();
      });
    }
  }
  return {
    update(items, viewer) {
      if (account !== viewer) { cache.clear(); account = viewer; }
      desired = new Map(items.filter(pr => pr.commentCount > 0).map(pr => [`${viewer}:${pr.id}:${pr.updatedAt}`, pr]));
      for (const [key, controller] of pending) if (!desired.has(key)) controller.abort();
      for (const [key] of desired) {
        const entry = cache.get(key);
        if (entry?.until > now()) apply(key, entry);
      }
      pump();
    },
    clear() {
      desired.clear(); cache.clear(); account = '';
      for (const controller of pending.values()) controller.abort();
    },
  };
}
