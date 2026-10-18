import { html, render as renderTemplate, repeat, nothing, live } from './vendor/lit-html.js';
import { githubUrl, usernameLink, repositoryLink } from './templates.js';
import { renderRow } from './row.js';
import { drawDependencies } from './dependencies.js';
import { createPollingSchedule, pendingPulls } from './polling.js';
import { createViewedStore, createLatestRequest, mergePullPages, createMergedStore } from './state.js';
import { createIssuePopover } from './issues.js';
import { element, icon, clipboardFeedback } from './ui.js';
import { assignNameColors, dependencyLanes, groupPulls, labels } from './model.js';
import { queryFromParams, queryPresets, setQueryPreset, normalizeQuery, queryError, matchesQueryState } from './query.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
if ([...$('group').options].some(option => option.value === params.get('group'))) $('group').value = params.get('group');
let appliedQuery = queryFromParams(params);
if (!queryError(appliedQuery)) appliedQuery = normalizeQuery(appliedQuery);
let items = [], total = 0, cursor = null, more = false, limited = false, loading = false;
const loads = createLatestRequest();
const mergedStore = createMergedStore();
const mergeSelections = new Map();
const polling = createPollingSchedule();
const issuePopover = createIssuePopover({ onClose: () => polling.invalidate() });
let statusLoading = false, statusController, statusOffset = 0, loadedPages = 1;
let events;
let authMode = 'local', authenticated = false;
let readinessTimer, readinessController;

function scheduleMergeReadiness(attempt = 0) {
  clearTimeout(readinessTimer);
  readinessController?.abort();
  if (polling.backingOff || document.hidden || !navigator.onLine || !authenticated || attempt >= 5 || !items.some(pr => pr.mergePending && pr.status === 'OPEN')) return;
  const version = loads.revision;
  readinessTimer = setTimeout(async () => {
    if (polling.backingOff || statusLoading || document.hidden || !navigator.onLine || loading) {
      scheduleMergeReadiness(attempt);
      return;
    }
    const pending = items.filter(pr => pr.mergePending && pr.status === 'OPEN').slice(0, 50);
    const query = new URLSearchParams(pending.map(pr => ['id', pr.id]));
    const requestController = new AbortController();
    readinessController = requestController;
    try {
      const response = await apiFetch(`/api/pulls/readiness?${query}`, { signal: requestController.signal });
      if (!response.ok) throw responseError(response, await response.json(), 'Could not check merge readiness.');
      const data = await response.json();
      if (version !== loads.revision || requestController.signal.aborted || !authenticated) return;
      for (const update of data.items) {
        const pr = items.find(item => item.id === update.id);
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

async function apiFetch(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401 && authMode === 'github-app') {
    authenticated = false;
    items = []; titleEdits.clear(); reviewChanges.clear(); draftChanges.clear(); merges.clear(); mergeSelections.clear();
    $('results').replaceChildren();
    $('dashboard').hidden = true;
    location.replace('/?auth_error=expired');
  }
  return response;
}

function updateRefreshButton() {
  const busy = loading || statusLoading;
  $('refresh').disabled = busy;
  const paused = document.hidden || !navigator.onLine;
  const seconds = Math.max(0, Math.ceil((polling.nextAt(pendingPulls(items).length > 0) - Date.now()) / 1000));
  $('refresh-countdown').textContent = busy ? '…' : paused ? 'Ⅱ' : String(seconds);
  const label = busy ? 'Refreshing…' : paused ? 'Refresh (auto refresh paused)' : `Refresh (auto refresh in ${seconds}s)`;
  $('refresh').title = label;
  $('refresh').setAttribute('aria-label', label);
  $('refresh').setAttribute('aria-busy', String(busy));
}

function savingPull(id) { return reviewChanges.get(id)?.saving || titleEdits.get(id)?.saving || draftChanges.get(id)?.saving || merges.get(id)?.saving; }
function protectedPull(id) {
  return reviewChanges.has(id) || titleEdits.has(id) || issuePopover.pullId === id || draftChanges.get(id)?.saving || merges.get(id)?.saving;
}
function responseError(response, data, fallback) {
  const error = new Error(data.error || fallback);
  error.retryAfter = Number(response.headers.get('Retry-After')) || 0;
  return error;
}

async function refreshStatus() {
  const pending = pendingPulls(items);
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
    if (version !== loads.revision || controller.signal.aborted || !authenticated) return;
    polling.succeeded('status');
    let changed = false, reconcile = false;
    for (const incoming of data.items) {
      const update = mergedStore.reconcile(incoming);
      const current = items.find(pr => pr.id === update.id);
      if (!current || savingPull(current.id) || Date.parse(update.updatedAt) < Date.parse(current.updatedAt)) continue;
      if (JSON.stringify(current) !== JSON.stringify(update)) {
        reconcile ||= ['status', 'checks', 'review'].some(key => current[key] !== update[key]);
        Object.assign(current, update); changed = true;
      }
    }
    if (reconcile) polling.invalidate();
    if (changed) {
      const count = items.length;
      items = items.filter(pr => matchesQueryState(pr, appliedQuery));
      total = Math.max(0, total - (count - items.length));
      render();
    }
    $('updated').textContent = `Checked ${new Date().toLocaleTimeString()}.`;
  } catch (error) {
    if (controller.signal.aborted || version !== loads.revision) return;
    polling.failed(error.retryAfter);
    $('updated').textContent = 'Background refresh failed. Retrying automatically.';
  } finally {
    if (statusController === controller) { statusLoading = false; updateRefreshButton(); }
  }
}

function poll() {
  if (!authenticated || !queryEditor || queryError(appliedQuery)) return;
  const kind = polling.due({ visible: !document.hidden, online: navigator.onLine,
    busy: loading || statusLoading, pending: pendingPulls(items).length > 0 });
  if (kind === 'list') load({ refresh: true, background: true });
  else if (kind === 'status') refreshStatus();
  updateRefreshButton();
}

function syncActivity() {
  if (document.hidden || !navigator.onLine || !authenticated) {
    events?.close(); events = null;
    clearTimeout(readinessTimer); readinessController?.abort();
    statusController?.abort();
  } else {
    if (!events) {
      events = new EventSource('/api/events');
      events.addEventListener('invalidate', () => { polling.invalidate(); poll(); });
    }
    poll();
  }
  updateRefreshButton();
}

const collapsed = new Set();
const reviewChanges = new Map();
const titleEdits = new Map();
const draftChanges = new Map();
const merges = new Map();
let viewerLogin = '';
const nameColorKey = 'gh-pull.name-colors.v1';
let nameColors = assignNameColors([]);
try { nameColors = assignNameColors([], JSON.parse(localStorage.getItem(nameColorKey))); } catch { /* Session colors still work if storage is unavailable. */ }
const viewedStore = createViewedStore({
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
});

function updateSummary() {
  $('summary').textContent = `${items.length} loaded · ${total} total${loading ? ' · Loading…' : ''}${limited ? ' · GitHub search returns at most 1,000 results. Narrow your query to see more specific results.' : ''}`;
}

function markViewed(pr) {
  if (viewedStore.mark(pr)) render();
}

window.addEventListener('storage', event => {
  if (viewedStore.storageChanged(event.key)) render();
});

// Keep conflict resolution, merge availability, and app-access messaging together.
function createMergeAction(pr, prUrl) {
  if (pr.status !== 'OPEN' || pr.author.toLowerCase() !== viewerLogin.toLowerCase()) return nothing;
  if (pr.hasConflicts) return prUrl ? html`<a class="badge review_required conflict-action" href=${githubUrl(prUrl, 'conflicts')}
    target="_blank" rel="noopener noreferrer" data-view-pr title="Resolve merge conflicts on GitHub (opens in a new tab)">Resolve conflict</a>` : nothing;
  if (!pr.canMerge) return nothing;
  const names = { MERGE: 'Merge', SQUASH: 'Squash and merge', REBASE: 'Rebase and merge' };
  const methods = (pr.mergeMethods ?? [pr.mergeMethod]).filter(method => names[method]);
  if (!methods.length) return nothing;
  if (!methods.includes(mergeSelections.get(pr.id))) mergeSelections.delete(pr.id);
  const selected = mergeSelections.get(pr.id) ?? (methods.includes(pr.mergeMethod) ? pr.mergeMethod : methods[0]);
  const blocked = authMode === 'github-app' && !pr.mergeAccess?.allowed;
  const disabled = blocked || Boolean(merges.get(pr.id)?.saving || draftChanges.get(pr.id)?.saving || titleEdits.has(pr.id));
  const controls = html`<span class=${`merge-controls${methods.length > 1 ? ' merge-split' : ''}`}>
    <button class="badge open merge-action" type="button" aria-label=${`${names[selected]} ${pr.repo} #${pr.number}`} ?disabled=${disabled}
      @click=${() => mergePull(pr, selected)}>${merges.get(pr.id)?.saving ? 'Merging…' : names[selected]}</button>
    ${methods.length > 1 ? html`<span class="merge-method-trigger open"><select class="merge-method" title="Merge method"
      aria-label=${`Merge method for ${pr.repo} #${pr.number}`} ?disabled=${disabled}
      @change=${event => { mergeSelections.set(pr.id, event.target.value); render(); }}>
      ${methods.map(method => html`<option value=${method} .selected=${method === selected}>${{ MERGE: 'Merge commit', SQUASH: 'Squash', REBASE: 'Rebase' }[method]}</option>`)}
    </select></span>` : nothing}
  </span>`;
  const message = pr.mergeAccess?.message || 'Could not verify app access. Refresh to try again.';
  return blocked ? html`<span class="merge-access-blocked" role="group" title=${message} tabindex="0" aria-label=${`${names[selected]} unavailable. ${message}`}>${controls}</span>
    ${pr.mergeAccess?.url ? html`<a class="merge-access-link" href=${pr.mergeAccess.url} target="_blank" rel="noopener noreferrer"
      title="Complete setup on GitHub, then refresh this page. Organization access may require owner approval.">${pr.mergeAccess.action}</a>` : nothing}` : controls;
}

const changeMessages = {
  title: { failure: 'Could not update the title. Please retry.', timeout: 'The save timed out. Retry to check and save the title.' },
  status: { failure: 'Could not change the PR status. Please retry.', timeout: 'Status change timed out. Click the status badge to retry or refresh to check its status.' },
  merge: { failure: 'Merge failed. Refresh to check its status.', timeout: 'Merge timed out. Refresh to check whether GitHub merged it.' },
};

// All mutations share pending/error handling and mark only the confirmed version
// as read. Action callbacks handle the few differences in visible state and focus.
async function changePull(pr, changes, { action, input = {}, apply, message, onSuccess, onError }) {
  const change = changes.get(pr.id) ?? {};
  if (change.saving) return;
  // An older read must not overwrite the mutation's confirmed result.
  loads.cancel(); loading = false;
  statusController?.abort(); statusLoading = false;
  clearTimeout(readinessTimer); readinessController?.abort();
  change.saving = true; change.error = '';
  changes.set(pr.id, change); render();
  const messages = changeMessages[action] ?? changeMessages.status;
  try {
    const response = await apiFetch(`/api/pulls/${action}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pr.id, ...input }), signal: AbortSignal.timeout(65_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || messages.failure);
    mergedStore.reconcile({ ...pr, ...data });
    apply(items.find(item => item.id === pr.id), data);
    changes.delete(pr.id); render();
    markViewed({ id: pr.id, updatedAt: data.updatedAt });
    $('summary').append(document.createTextNode(` · ${message}`));
    polling.invalidate();
    onSuccess?.();
  } catch (error) {
    change.saving = false;
    change.error = error.name === 'TimeoutError' ? messages.timeout : error.message;
    render(); onError?.();
  }
}

async function mergePull(pr, mergeMethod) {
  if (authMode === 'github-app' && !pr.mergeAccess?.allowed) return;
  await changePull(pr, merges, {
    action: 'merge', input: { headOid: pr.headOid, mergeMethod },
    message: `Merged ${pr.repo} #${pr.number}`,
    onSuccess: () => { void load({ refresh: true, background: true }); },
    apply(current, data) {
      if (!current) return;
      Object.assign(current, data);
      items = items.map(item => mergedStore.reconcile(item));
      if (!matchesQueryState(current, appliedQuery)) {
        items = items.filter(item => item.id !== pr.id);
        total = Math.max(0, total - 1);
      }
    },
  });
}

async function changeDraftStatus(pr) {
  const toDraft = pr.status === 'OPEN';
  await changePull(pr, draftChanges, {
    action: toDraft ? 'draft' : 'ready',
    message: toDraft ? 'PR converted to draft' : 'PR ready for review',
    apply(current, data) {
      if (current) Object.assign(current, { status: data.status, updatedAt: data.updatedAt, review: data.review, canMerge: false, mergePending: !toDraft });
    },
    onSuccess: scheduleMergeReadiness,
  });
}

function reviewControl(pr, reviewer) {
  const panelId = `review-${pr.id}`;
  const draft = reviewChanges.get(pr.id);
  const close = () => { if (!draft?.saving) document.getElementById(panelId)?.hidePopover(); };
  const open = event => {
    reviewChanges.set(pr.id, { reviewId: reviewer.reviewId, value: '', confirm: false, saving: false, error: '' });
    const rect = event.currentTarget.getBoundingClientRect();
    renderEditorRow(pr.id);
    const panel = document.getElementById(panelId);
    panel.style.left = `${Math.max(8, Math.min(rect.right - 340, innerWidth - 348))}px`;
    panel.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - 310))}px`;
    panel.showPopover();
    panel.querySelector('button')?.focus();
  };
  const submit = async event => {
    event.preventDefault();
    if (draft.saving || !draft.value.trim()) return;
    await changePull(pr, reviewChanges, {
      action: 'revoke', input: { reviewId: draft.reviewId, message: draft.value.trim() },
      message: 'Approval revoked',
      apply(current, data) { if (current) Object.assign(current, data); },
      onSuccess: () => { focusTitleControl(pr.id, '.pr-title'); scheduleMergeReadiness(); void load({ refresh: true, background: true }); },
      onError: () => { const panel = document.getElementById(panelId); if (panel && !panel.matches(':popover-open')) panel.showPopover(); },
    });
  };
  return html`<button type="button" class="badge approved review-action" aria-label="Your approval options"
      aria-haspopup="dialog" ?disabled=${draft?.saving} @click=${open}><span class="badge approved review-status" aria-hidden="true">✓</span><svg class="review-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="m2.5 3.75 2.5 2.5 2.5-2.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <div id=${panelId} class="review-popover" popover="auto" role="dialog" aria-label="Your approval"
      @toggle=${event => {
        if (event.newState === 'closed' && !reviewChanges.get(pr.id)?.saving) {
          reviewChanges.delete(pr.id); renderEditorRow(pr.id); focusTitleControl(pr.id, '.review-action'); polling.invalidate();
        }
      }}>
      ${draft?.confirm ? html`<form @submit=${submit}>
        <strong>Revoke your approval?</strong>
        <p>Your review and comments will remain, but this approval will no longer count toward merging.</p>
        <label>Reason <span class="review-required">· required</span>
          <textarea aria-label="Reason" required maxlength="1000" .value=${live(draft.value)} ?disabled=${draft.saving}
            @input=${event => { draft.value = event.target.value; renderEditorRow(pr.id); }}></textarea>
        </label>
        ${draft.error ? html`<p class="error-message" role="alert">${draft.error}</p>` : nothing}
        <div class="review-buttons"><button type="button" ?disabled=${draft.saving} @click=${close}>Cancel</button>
        <button type="submit" ?disabled=${draft.saving || !draft.value.trim()}>${draft.saving ? 'Revoking…' : 'Revoke approval'}</button></div>
      </form>` : html`<a href=${githubUrl(reviewer.reviewUrl)} target="_blank" rel="noopener noreferrer">View review ↗</a>
        <button type="button" @click=${() => { draft.confirm = true; renderEditorRow(pr.id); document.getElementById(panelId).querySelector('textarea').focus(); }}>Revoke approval…</button>`}
    </div>`;
}

function focusTitleControl(id, selector) {
  [...$('results').querySelectorAll('.pr-row')].find(row => row.dataset.prId === id)?.querySelector(selector)?.focus();
}

function titleEditor(pr) {
  const draft = titleEdits.get(pr.id);
  const close = () => {
    if (draft.saving) return;
    titleEdits.delete(pr.id); render(); focusTitleControl(pr.id, '.edit-title'); polling.invalidate();
  };
  const submit = async event => {
    event.preventDefault();
    if (draft.saving || !draft.value.trim() || draft.value.trim() === draft.expectedTitle) return;
    await changePull(pr, titleEdits, {
      action: 'title', input: { title: draft.value.trim(), expectedTitle: draft.expectedTitle }, message: 'Title updated',
      apply(current, data) { if (current) Object.assign(current, { title: data.title, updatedAt: data.updatedAt }); },
      onSuccess: () => focusTitleControl(pr.id, '.edit-title'),
      onError: () => focusTitleControl(pr.id, '.title-editor input'),
    });
  };
  return html`<form class="title-editor" aria-label=${`Edit title of ${pr.repo} #${pr.number}`} @submit=${submit}
    @keydown=${event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
    <input type="text" .value=${live(draft.value)} required maxlength="256" aria-label="Pull request title" ?disabled=${draft.saving}
      @input=${event => { draft.value = event.target.value; renderEditorRow(pr.id); }}>
    <button type="submit" ?disabled=${draft.saving || !draft.value.trim() || draft.value.trim() === draft.expectedTitle}>${draft.saving ? 'Saving…' : 'Save'}</button>
    <button type="button" ?disabled=${draft.saving} @click=${close}>Cancel</button>
    ${draft.error ? html`<p class="title-error error-message" role="alert">${draft.error}</p>` : nothing}
  </form>`;
}

// Row containers survive regrouping; Lit owns and diffs everything inside.
const rowElements = new Map();
const groupCache = new Map();
const rowContext = () => ({ viewedStore, markViewed, viewerLogin, draftChanges, merges, titleEdits,
  changeDraftStatus, render, focusTitleControl, createMergeAction, issuePopover, titleEditor, reviewControl, nameColors });
function renderEditorRow(id) {
  const row = rowElements.get(id);
  if (row) renderTemplate(renderRow(row.node, row.gutter, rowContext()), row.entry);
}


// Keep retained nodes mounted; moving a node only when its order changes also
// preserves browser-managed focus and popover state on ordinary refreshes.
function place(parent, child, before) {
  if (child === before) return;
  if (child.parentElement === parent && parent.moveBefore) parent.moveBefore(child, before);
  else {
    const focused = child.contains(document.activeElement) ? document.activeElement : null;
    const selection = focused && typeof focused.selectionStart === 'number'
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    parent.insertBefore(child, before);
    focused?.focus({ preventScroll: true });
    if (selection) focused.setSelectionRange(...selection);
  }
}

function render() {
  const { count, groups } = groupPulls(items, { group: $('group').value, sort: 'query' });
  updateSummary();
  const focused = document.activeElement;
  const selection = typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
  const results = $('results'), activeGroups = new Set(), activeRows = new Set();
  let nextSection = results.firstElementChild;
  const ctx = rowContext();
  for (const [name, prs] of groups) {
    const key = `${$('group').value}:${name}`;
    activeGroups.add(key);
    let group = groupCache.get(key);
    if (!group) {
      const section = element('details', undefined, 'pr-group');
      section.open = !collapsed.has(key);
      section.addEventListener('toggle', () => section.open ? collapsed.delete(key) : collapsed.add(key));
      const heading = element('summary'), list = element('ul', undefined, 'pr-list');
      section.append(heading, list);
      group = { section, heading, list, clear: () => {} };
      groupCache.set(key, group);
    }
    const { section, heading, list } = group;
    place(results, section, nextSection);
    nextSection = section.nextElementSibling;
    renderTemplate(html`${$('group').value === 'repo' ? repositoryLink(name)
      : $('group').value === 'author' ? usernameLink(name) : labels[name] ?? name} (${prs.length})`, heading);
    const graph = dependencyLanes(prs, { allItems: items, sort: queryPresets(appliedQuery).sort });
    list.classList.toggle('has-dependency-lanes', Boolean(graph.gutter));
    if (graph.gutter) list.style.setProperty('--lane-gutter', `${graph.gutter}px`);
    else list.style.removeProperty('--lane-gutter');
    // Lit repeat owns ordering. Restore focus if a browser drops it while
    // moving a keyed range (including the native popover trigger).
    const entries = graph.rows.map(node => {
      const entry = rowElements.get(node.pr.id)?.entry ?? element('li', undefined, 'dependency-node');
      rowElements.set(node.pr.id, { entry, node, gutter: graph.gutter });
      activeRows.add(node.pr.id);
      renderTemplate(renderRow(node, graph.gutter, ctx), entry);
      return { id: node.pr.id, entry };
    });
    renderTemplate(repeat(entries, row => row.id, row => row.entry), list);
    const graphKey = JSON.stringify([graph.gutter, graph.rows.map(n =>
      [n.pr.id, n.lane, n.parentIndex, n.nodeStatus, n.externalParent, n.unloadedBase])]);
    if (group.graphKey !== graphKey) {
      group.clear();
      group.clear = graph.gutter ? drawDependencies([{ list, graph }]) : () => {};
      group.graphKey = graphKey;
    }
  }
  for (const [id, { entry }] of rowElements) if (!activeRows.has(id)) {
    renderTemplate(nothing, entry); entry.remove(); rowElements.delete(id);
  }
  for (const [key, group] of groupCache) if (!activeGroups.has(key)) {
    group.clear(); group.section.remove(); groupCache.delete(key);
  }
  if (issuePopover.isOpen && !activeRows.has(issuePopover.pullId)) issuePopover.close();
  if (focused?.isConnected && document.activeElement !== focused) {
    focused.focus({ preventScroll: true });
    if (selection) focused.setSelectionRange(...selection);
  }
  issuePopover.reposition();
  results.querySelector('.empty')?.remove();
  if (!count && !loading) results.append(element('p', 'No pull requests found for this query.', 'empty'));
  results.setAttribute('aria-busy', String(loading));
  $('more').hidden = !more; $('more').disabled = loading;
  updateRefreshButton();
}

async function load({ append = false, refresh = false, background = false } = {}) {
  if (!authenticated || !queryEditor) return;
  if (queryError(appliedQuery)) {
    updateQueryControls();
    $('summary').textContent = 'Enter a valid query to load pull requests.';
    polling.succeeded('list');
    updateRefreshButton();
    return;
  }
  clearTimeout(readinessTimer); readinessController?.abort();
  statusController?.abort(); statusLoading = false;
  const mergeErrorsToClear = new Map(refresh && !background ? [...merges].filter(([, change]) => !change.saving) : []);
  const request = loads.start();
  const pollRevision = polling.revision;
  if (!append && !refresh) { loadedPages = 1; items = []; total = 0; cursor = null; more = false; limited = false; }
  loading = true; $('error').hidden = true;
  if (refresh) {
    // Keep the current rows mounted until fresh data is ready.
    updateSummary();
    updateRefreshButton();
    $('results').setAttribute('aria-busy', 'true');
    $('more').disabled = true;
  } else render();
  const query = new URLSearchParams({ q: appliedQuery });
  if (append && cursor) query.set('cursor', cursor);
  if (refresh && !background) query.set('refresh', '1');
  try {
    let data, fetchedItems = [], pages = 0;
    do {
      const response = await apiFetch(`/api/pulls?${query}`, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]) });
      data = await response.json();
      if (!response.ok) throw responseError(response, data, 'Could not load pull requests.');
      fetchedItems.push(...data.items); pages++;
      if (!refresh || pages >= loadedPages || !data.pageInfo.hasNextPage) break;
      query.set('cursor', data.pageInfo.endCursor);
    } while (loads.isCurrent(request));
    data.items = fetchedItems;
    if (!loads.isCurrent(request)) return;
    if (viewedStore.selectAccount(data.viewer)) {
      queryEditor?.clearRepositoryCache();
      issuePopover.close();
      mergedStore.clear();
      titleEdits.clear(); reviewChanges.clear();
      draftChanges.clear();
      merges.clear(); mergeSelections.clear();
    }
    polling.succeeded('list', pollRevision);
    // Preserve confirmed mutations if search indexing briefly returns an older version.
    if (background) {
      const previous = new Map(items.map(pr => [pr.id, pr]));
      data.items = data.items.map(pr => Date.parse(previous.get(pr.id)?.updatedAt) > Date.parse(pr.updatedAt) ? previous.get(pr.id) : pr);
    }
    // Preserve only active rows; unrelated PRs can continue refreshing.
    const protectedItems = new Map(items.filter(pr => protectedPull(pr.id)).map(pr => [pr.id, pr]));
    data.items = data.items.map(pr => savingPull(pr.id) ? protectedItems.get(pr.id) ?? pr : mergedStore.reconcile(pr));
    let retainedMissing = 0;
    for (const [index, pr] of items.entries()) {
      if (protectedItems.has(pr.id) && !data.items.some(item => item.id === pr.id)) {
        data.items.splice(Math.min(index, data.items.length), 0, pr);
        retainedMissing++;
      }
    }
    // These rows remain visible locally until protection ends and we refetch.
    if (!append) data.total += retainedMissing;
    const excluded = new Set(data.items.filter(pr => !matchesQueryState(pr, appliedQuery)).map(pr => pr.id));
    data.items = data.items.filter(pr => !excluded.has(pr.id));
    data.total = Math.max(0, data.total - excluded.size);
    loadedPages = append ? loadedPages + 1 : pages;
    viewerLogin = data.viewer;
    items = mergePullPages(items, data.items, append);
    for (const pr of data.items) {
      const previous = mergeErrorsToClear.get(pr.id);
      if (previous && merges.get(pr.id) === previous) merges.delete(pr.id);
    }
    nameColors = assignNameColors(items.flatMap(pr => [pr.author, ...(pr.reviewers ?? []).map(reviewer => reviewer.name)]), nameColors);
    try { localStorage.setItem(nameColorKey, JSON.stringify(nameColors)); } catch { /* Keep assignments stable for this session. */ }
    total = data.total; cursor = data.pageInfo.endCursor; more = data.pageInfo.hasNextPage;
    limited = data.limited;
    if (limited && items.length >= 1000) more = false;
    $('updated').textContent = `Fetched ${new Date().toLocaleTimeString()}.`;
  } catch (error) {
    if (!loads.isCurrent(request) || error.name === 'AbortError') return;
    polling.failed(error.retryAfter);
    $('error').replaceChildren(element('span', error.message + ' '));
    const retry = element('button', 'Retry'); retry.type = 'button';
    retry.addEventListener('click', () => load({ append, refresh: true }));
    $('error').append(retry); $('error').hidden = false;
  } finally {
    if (loads.isCurrent(request)) {
      loading = false;
      render();
      scheduleMergeReadiness();
    }
  }
}

function saveFilters() {
  const query = new URLSearchParams({ q: appliedQuery, group: $('group').value });
  history.replaceState(null, '', `?${query}`);
}
let queryEditor;
async function initializeQueryEditor() {
  if (queryEditor) return;
  const { createQueryEditor } = await import('./query-editor.js');
  queryEditor = createQueryEditor({
    parent: $('query-editor'), value: appliedQuery, getItems: () => items,
    getRepositories: async scope => {
      const response = await apiFetch(`/api/repositories?${new URLSearchParams({ q: scope })}`, { signal: AbortSignal.timeout(35_000) });
      const data = await response.json();
      if (!response.ok) throw responseError(response, data, 'Could not load repository suggestions.');
      return data;
    },
    onChange: updateQueryControls, onSubmit: applyQuery,
  });
  updateQueryControls();
}
function updateQueryControls() {
  const value = queryEditor.value;
  for (const [control, preset] of Object.entries(queryPresets(value))) $(control).value = preset;
  const error = queryError(value);
  const hint = value !== appliedQuery ? 'Unapplied changes · Enter to search' : 'Enter to search';
  if ($('query-hint').textContent !== hint) $('query-hint').textContent = hint;
  const feedback = error || '';
  if ($('query-feedback').textContent !== feedback) $('query-feedback').textContent = feedback;
  $('query-help').hidden = Boolean(error);
  $('query-feedback').hidden = !error;
  $('query-feedback').classList.toggle('query-error', Boolean(error));
  $('query-editor').classList.toggle('invalid', Boolean(error));
  $('query-submit').disabled = Boolean(error);
}
function applyQuery() {
  if (queryError(queryEditor.value)) { updateQueryControls(); return; }
  const next = normalizeQuery(queryEditor.value);
  const changed = next !== appliedQuery;
  appliedQuery = next;
  queryEditor.setValue(next);
  updateQueryControls(); saveFilters();
  load({ refresh: !changed });
}
$('filters').addEventListener('submit', event => { event.preventDefault(); applyQuery(); });
for (const id of ['scope', 'state', 'sort']) $(id).addEventListener('change', () => {
  queryEditor.setValue(setQueryPreset(queryEditor.value, id, $(id).value));
  applyQuery();
});
$('group').addEventListener('change', () => { saveFilters(); render(); });
$('refresh').addEventListener('click', () => load({ refresh: true }));
$('more').addEventListener('click', () => load({ append: true }));
setInterval(poll, 1000);
document.addEventListener('visibilitychange', syncActivity);
window.addEventListener('online', syncActivity);
window.addEventListener('offline', syncActivity);
window.addEventListener('focus', poll);
// Returning from a mouse-opened tab should not leave the link focused.
// Keyboard activation (detail === 0) keeps focus for continued navigation.
document.addEventListener('click', event => {
  if (event.detail > 0) event.target.closest('a[target="_blank"]')?.blur();
});
window.addEventListener('pagehide', () => { events?.close(); events = null; });
window.addEventListener('pageshow', syncActivity);

$('update-copy-symbol').append(icon('copy', 14));
clipboardFeedback($('copy-update-command'), {
  text: $('update-command').textContent,
  symbol: $('update-copy-symbol'),
  feedback: $('update-copy-feedback'),
  success: 'Update command copied',
});

let updateTimer;
let extensionUpdatesEnabled = false;
document.addEventListener('visibilitychange', checkExtensionUpdate);
window.addEventListener('focus', checkExtensionUpdate);
window.addEventListener('online', checkExtensionUpdate);
async function checkExtensionUpdate() {
  if (!extensionUpdatesEnabled || document.hidden) return;
  try {
    const response = await fetch('/api/updates');
    if (!response.ok) return;
    const { update } = await response.json();
    $('update-notice').hidden = !update;
    if (update) {
      $('update-release').textContent = `gh-pull ${update.version}`;
      $('update-release').href = update.url;
    }
  } catch { /* Update checks must not interrupt the dashboard. */ }
}

async function initializeSession() {
  $('session-retry').hidden = true;
  $('session-status').hidden = false;
  $('session-status').textContent = 'Connecting…';
  try {
    const response = await fetch('/api/session');
    if (!response.ok) throw new Error('Could not connect. Please retry.');
    const session = await response.json();
    clearInterval(updateTimer);
    extensionUpdatesEnabled = session.mode === 'local' && Boolean(session.version?.label);
    if (extensionUpdatesEnabled) {
      void checkExtensionUpdate();
      updateTimer = setInterval(checkExtensionUpdate, 5 * 60 * 1000);
    }
    const version = $('deployed-version');
    version.replaceChildren();
    version.hidden = !session.version;
    if (session.version) {
      const commit = element(session.version.url ? 'a' : 'span', session.version.label ?? session.version.sha.slice(0, 7));
      commit.title = session.version.label ? `Installed version: ${session.version.label}` : `Deployed commit: ${session.version.sha}`;
      if (session.version.url) {
        commit.href = session.version.url;
        commit.target = '_blank'; commit.rel = 'noopener noreferrer';
      }
      const separator = element('span', ' | ');
      separator.setAttribute('aria-hidden', 'true');
      version.append('version ', commit, separator);
    }
    authMode = session.mode;
    authenticated = session.authenticated;
    $('signin').hidden = authenticated;
    $('dashboard').hidden = true;
    $('links-hint').hidden = !authenticated;
    $('refresh').hidden = !authenticated;
    $('logout').hidden = authMode !== 'github-app' || !authenticated;
    $('install').hidden = authMode !== 'github-app' || !authenticated || !session.installUrl;
    if (session.installUrl) $('install').href = session.installUrl;
    const notices = { state: 'Sign-in expired or could not be verified. Please try again.', denied: 'GitHub authorization was cancelled. Sign in when you are ready.', exchange: 'Could not complete GitHub sign-in. Please try again.', expired: 'Your session expired or authorization was revoked. Please sign in again.' };
    const notice = notices[params.get('auth_error')];
    $('auth-notice').hidden = !notice;
    if (notice) $('auth-notice').textContent = notice;
    $('session-status').hidden = true;
    if (authenticated) {
      await initializeQueryEditor();
      $('dashboard').hidden = false;
      await load();
      syncActivity();
    }
  } catch {
    authenticated = false;
    $('dashboard').hidden = true;
    $('refresh').hidden = true;
    $('session-status').hidden = false;
    $('session-status').textContent = 'Could not connect. Please retry.';
    $('session-retry').hidden = false;
  }
}
$('session-retry').addEventListener('click', initializeSession);
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try {
    const response = await fetch('/auth/logout', { method: 'POST' });
    if (!response.ok) throw new Error();
    authenticated = false;
    loads.cancel();
    location.replace('/');
  } catch {
    $('auth-notice').textContent = 'Could not sign out. Please retry.';
    $('auth-notice').hidden = false;
    $('logout').disabled = false;
  }
});
initializeSession();
