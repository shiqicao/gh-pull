import { queryError, matchesQueryState } from './query.js';

// Scheduling is independent of the DOM and transport so time/backoff can be tested.
export const LIST_INTERVAL = 30_000;
export const STATUS_INTERVAL = 15_000;
export function createPollingSchedule(now = Date.now) {
  let listAt = now(), statusAt = now(), failures = 0, blockedUntil = 0, invalidated = false, revision = 0;
  return {
    get revision() { return revision; },
    get backingOff() { return now() < blockedUntil; },
    invalidate() { invalidated = true; revision++; },
    nextAt(pending = false) {
      return Math.max(blockedUntil, invalidated ? 0 : Math.min(listAt + LIST_INTERVAL, pending ? statusAt + STATUS_INTERVAL : Infinity));
    },
    due({ visible = true, online = true, busy = false, pending = false } = {}) {
      if (!visible || !online || busy || now() < this.nextAt(pending)) return null;
      return invalidated || now() >= listAt + LIST_INTERVAL ? 'list' : 'status';
    },
    succeeded(kind, startedAtRevision = revision) {
      failures = 0; blockedUntil = 0;
      statusAt = now();
      if (kind === 'list') { listAt = now(); if (startedAtRevision === revision) invalidated = false; }
    },
    failed(retryAfter = 0) {
      failures++;
      blockedUntil = now() + Math.max(Math.min(30_000 * 2 ** Math.min(failures - 1, 4), 300_000), retryAfter * 1000);
    },
  };
}

export function pendingPulls(items) {
  return items.filter(pr => ['OPEN', 'DRAFT'].includes(pr.status) && (['PENDING', 'EXPECTED'].includes(pr.checks) || pr.mergePending));
}

export function createBackgroundRefresh({ state, polling, loads, mergedStore, apiFetch, responseError, savingPull, render, load, updateRefreshButton, onUpdate }) {
  let statusLoading = false, statusController, statusOffset = 0, events, readinessTimer, readinessController;
  function closeEvents() { events?.close(); events = null; }

  function cancelBackgroundRequests(resetStatus = false) {
    clearTimeout(readinessTimer); readinessController?.abort();
    statusController?.abort();
    if (resetStatus) statusLoading = false;
  }

  function scheduleMergeReadiness(attempt = 0) {
    clearTimeout(readinessTimer);
    readinessController?.abort();
    if (polling.backingOff || document.hidden || !navigator.onLine || !state.authenticated || attempt >= 5 || !state.items.some(pr => pr.mergePending && pr.status === 'OPEN')) return;
    const version = loads.revision;
    readinessTimer = setTimeout(async () => {
      if (polling.backingOff || statusLoading || document.hidden || !navigator.onLine || state.loading) {
        scheduleMergeReadiness(attempt);
        return;
      }
      const pending = state.items.filter(pr => pr.mergePending && pr.status === 'OPEN').slice(0, 50);
      const query = new URLSearchParams(pending.map(pr => ['id', pr.id]));
      const requestController = new AbortController();
      readinessController = requestController;
      try {
        const response = await apiFetch(`/api/pulls/readiness?${query}`, { signal: requestController.signal });
        if (!response.ok) throw responseError(response, await response.json(), 'Could not check merge readiness.');
        const data = await response.json();
        if (version !== loads.revision || requestController.signal.aborted || !state.authenticated) return;
        for (const update of data.items) {
          const pr = state.items.find(item => item.id === update.id);
          // Never offer a merge against a commit that is not the displayed version.
          if (pr?.status === 'OPEN' && !savingPull(pr.id) && pr.headOid === update.headOid) Object.assign(pr, update);
        }
        render();
      } catch (error) {
        if (error.retryAfter) polling.failed(error.retryAfter);
        // Normal polling retries unresolved merge readiness.
      }
      if (version === loads.revision && !requestController.signal.aborted) scheduleMergeReadiness(attempt + 1);
    }, 2000);
  }

  async function refreshStatus() {
    const pending = pendingPulls(state.items);
    if (!pending.length) return;
    // Rotate batches so large dashboards do not starve later PRs.
    statusOffset %= pending.length;
    const selected = [...pending.slice(statusOffset), ...pending.slice(0, statusOffset)].slice(0, 50);
    statusOffset += selected.length;
    const version = loads.revision;
    const controller = new AbortController(); statusController = controller;
    statusLoading = true; updateRefreshButton();
    clearTimeout(readinessTimer); readinessController?.abort();
    try {
      const query = new URLSearchParams(selected.map(pr => ['id', pr.id]));
      const response = await apiFetch(`/api/pulls/status?${query}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]) });
      const data = await response.json();
      if (!response.ok) throw responseError(response, data, 'Could not refresh running checks.');
      if (version !== loads.revision || controller.signal.aborted || !state.authenticated) return;
      polling.succeeded('status');
      let changed = false, reconcile = false;
      for (const incoming of data.items) {
        const update = mergedStore.reconcile(incoming);
        const current = state.items.find(pr => pr.id === update.id);
        if (!current || savingPull(current.id) || Date.parse(update.updatedAt) < Date.parse(current.updatedAt)) continue;
        if (JSON.stringify(current) !== JSON.stringify(update)) {
          reconcile ||= ['status', 'checks', 'review'].some(key => current[key] !== update[key]);
          Object.assign(current, update); changed = true;
        }
      }
      if (reconcile) polling.invalidate();
      if (changed) {
        const count = state.items.length;
        state.items = state.items.filter(pr => matchesQueryState(pr, state.appliedQuery));
        state.total = Math.max(0, state.total - (count - state.items.length));
        render();
      }
      onUpdate(`Checked ${new Date().toLocaleTimeString()}.`);
    } catch (error) {
      if (controller.signal.aborted || version !== loads.revision) return;
      polling.failed(error.retryAfter);
      onUpdate('Background refresh failed. Retrying automatically.');
    } finally {
      if (statusController === controller) { statusLoading = false; updateRefreshButton(); }
    }
  }

  function poll() {
    if (!state.authenticated || !state.queryReady || queryError(state.appliedQuery)) return;
    const kind = polling.due({ visible: !document.hidden, online: navigator.onLine,
      busy: state.loading || statusLoading, pending: pendingPulls(state.items).length > 0 });
    if (kind === 'list') load({ refresh: true, background: true });
    else if (kind === 'status') refreshStatus();
    updateRefreshButton();
  }

  function syncActivity() {
    if (document.hidden || !navigator.onLine || !state.authenticated) {
      closeEvents();
      cancelBackgroundRequests();
    } else {
      if (!events) {
        events = new EventSource('/api/events');
        events.addEventListener('invalidate', () => { polling.invalidate(); poll(); });
      }
      poll();
    }
    updateRefreshButton();
  }

  return { scheduleMergeReadiness, cancelBackgroundRequests, poll, syncActivity, closeEvents,
    get statusLoading() { return statusLoading; } };
}
