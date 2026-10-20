import { normalizeViewedUpdates, hasUnviewedUpdate } from './model.js';

// Storage is injected so browser persistence is optional and logic stays testable.
export function createViewedStore(storage) {
  let key = null, viewed = {};
  function read() {
    try { return normalizeViewedUpdates(JSON.parse(storage.getItem(key))); }
    catch { return viewed; }
  }
  function sync() {
    for (const [id, timestamp] of Object.entries(read())) {
      viewed[id] = Math.max(viewed[id] ?? 0, timestamp);
    }
  }
  return {
    selectAccount(login) {
      const next = `gh-pull.viewed.v1:${login.toLowerCase()}`;
      const changed = key !== next;
      if (changed) { key = next; viewed = {}; }
      sync();
      return changed;
    },
    hasUpdates(pr) { return hasUnviewedUpdate(pr, viewed); },
    mark(pr) {
      const timestamp = Date.parse(pr.updatedAt);
      if (!key || !Number.isFinite(timestamp)) return false;
      sync();
      // Record the confirmed version, never wall-clock time or a future update.
      viewed[pr.id] = Math.max(viewed[pr.id] ?? 0, timestamp);
      try { storage.setItem(key, JSON.stringify(viewed)); } catch { /* Keep session-only tracking. */ }
      return true;
    },
    storageChanged(changedKey) {
      if (!key || (changedKey !== key && changedKey !== null)) return false;
      // Explicit removal/clear resets history; normal loads merge monotonically.
      viewed = read();
      return true;
    },
  };
}

// Cancellation is best effort: the identity check also rejects responses that
// completed just before abort, or transports that ignore the abort signal.
export function createLatestRequest() {
  let current = null, revision = 0;
  return {
    get revision() { return revision; },
    start() {
      current?.controller.abort();
      const controller = new AbortController();
      current = { controller, signal: controller.signal, revision: ++revision };
      return current;
    },
    isCurrent(request) { return request === current && !request.signal.aborted; },
    cancel() {
      current?.controller.abort();
      current = null;
      revision++;
    },
  };
}

export function mergePullPages(previous, incoming, append) {
  return [...new Map([...(append ? previous : []), ...incoming].map(pr => [pr.id, pr])).values()];
}

// Merging is irreversible. Remember confirmations even after a row is removed,
// so a stale search result cannot resurrect it as open. Scoped to one account.
export function createMergedStore() {
  const merged = new Map(), transitions = new Map();
  return {
    clear() { merged.clear(); transitions.clear(); },
    confirm(pr) {
      transitions.set(pr.id, { status: pr.status, updatedAt: pr.updatedAt, canClose: pr.canClose, canReopen: pr.canReopen,
        canMerge: pr.canMerge ?? false, mergePending: pr.mergePending ?? false });
    },
    reconcile(pr) {
      const transition = transitions.get(pr.id);
      if (transition) {
        if (pr.status === 'MERGED' || Date.parse(pr.updatedAt) > Date.parse(transition.updatedAt)) transitions.delete(pr.id);
        else pr = { ...pr, ...transition };
      }
      const parentTransition = transitions.get(pr.dependencyParent?.id);
      if (parentTransition && (pr.dependencyParent.status === 'MERGED' || Date.parse(pr.dependencyParent.updatedAt) > Date.parse(parentTransition.updatedAt))) {
        transitions.delete(pr.dependencyParent.id);
      }
      const parent = merged.get(pr.dependencyParent?.id) ?? transitions.get(pr.dependencyParent?.id);
      if (parent) pr = { ...pr, dependencyParent: { ...pr.dependencyParent, ...parent } };
      const known = merged.get(pr.id);
      if (pr.status === 'MERGED' && (!known || Date.parse(pr.updatedAt) >= Date.parse(known.updatedAt))) {
        merged.set(pr.id, { status: 'MERGED', updatedAt: pr.updatedAt, canMerge: false, mergePending: false });
      }
      const confirmation = merged.get(pr.id);
      if (!confirmation) return pr;
      return { ...pr, ...confirmation,
        updatedAt: Date.parse(pr.updatedAt) > Date.parse(confirmation.updatedAt) ? pr.updatedAt : confirmation.updatedAt };
    },
  };
}
