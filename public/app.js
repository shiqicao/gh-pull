import { assignNameColors, NAME_COLOR_COUNT, groupPulls, labels, relativeTime, normalizeViewedUpdates, hasUnviewedUpdate } from './model.js';

const $ = id => document.getElementById(id);
const controls = ['scope', 'state', 'search', 'group', 'sort'];
const params = new URLSearchParams(location.search);
const demoMode = params.get('demo') === '1';
const demoClient = demoMode ? (await import('./demo.js')).createDemoClient() : null;
const apiFetch = (path, options) => demoClient ? demoClient.request(path, options) : fetch(path, options);
if (demoMode) {
  $('scope').value = 'involved'; $('state').value = 'all';
  document.title = 'gh-pull · Demo';
}
for (const id of controls) {
  const input = $(id), value = params.get(id);
  if (value !== null && (id === 'search' || [...input.options].some(option => option.value === value))) input.value = value;
}
let items = [], total = 0, cursor = null, more = false, limited = false, loading = false, controller, generation = 0;
const collapsed = new Set();
const titleEdits = new Map();
const draftChanges = new Map();
let viewerLogin = '';
const nameColorKey = demoMode ? 'gh-pull.demo.name-colors.v1' : 'gh-pull.name-colors.v1';
let nameColors = assignNameColors([]);
try { nameColors = assignNameColors([], JSON.parse(localStorage.getItem(nameColorKey))); } catch { /* Session colors still work if storage is unavailable. */ }
let viewedKey = null, viewedUpdates = {};

function readViewedUpdates() {
  try { return normalizeViewedUpdates(JSON.parse(localStorage.getItem(viewedKey))); }
  catch { return viewedUpdates; }
}

function updateSummary() {
  const { count } = groupPulls(items, { search: $('search').value, group: $('group').value, sort: $('sort').value });
  $('summary').textContent = `${count} shown · ${items.length} loaded · ${total} total${loading ? ' · Loading…' : ''}${limited ? ' · GitHub search returns at most 1,000 results; use Created by me for your full history.' : ''}`;
}

function updateTitleBrightness() {
  const byId = new Map(items.map(pr => [pr.id, pr]));
  for (const row of $('results').querySelectorAll('.pr-row')) {
    const pr = byId.get(row.dataset.prId);
    const hasUpdates = pr && hasUnviewedUpdate(pr, viewedUpdates);
    row.classList.toggle('has-updates', Boolean(hasUpdates));
    if (pr) row.querySelector('.pr-title').setAttribute('aria-label', `${hasUpdates ? 'New updates: ' : ''}${pr.title} (opens in a new tab)`);
  }
  updateSummary();
}

function markViewed(pr) {
  const timestamp = Date.parse(pr.updatedAt);
  if (!Number.isFinite(timestamp) || !viewedKey) return;
  const saved = readViewedUpdates();
  for (const [id, seen] of Object.entries(saved)) viewedUpdates[id] = Math.max(viewedUpdates[id] ?? 0, seen);
  // Record the version actually shown, not the current time: a newer update may
  // already exist on GitHub but not yet have reached this dashboard's cache.
  viewedUpdates[pr.id] = Math.max(viewedUpdates[pr.id] ?? 0, timestamp);
  try { localStorage.setItem(viewedKey, JSON.stringify(viewedUpdates)); } catch { /* Session-only tracking when storage is unavailable. */ }
  updateTitleBrightness();
}

window.addEventListener('storage', event => {
  if (viewedKey && (event.key === viewedKey || event.key === null)) {
    viewedUpdates = readViewedUpdates();
    updateTitleBrightness();
  }
});

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function badge(text, kind) { return element('span', text, `badge ${kind.toLowerCase()}`); }

function usernameBadge(username) {
  const name = badge(username, 'author');
  name.style.setProperty('--author-hue', nameColors[username.toLowerCase()] * 360 / NAME_COLOR_COUNT);
  return name;
}

function repositoryLink(repo) {
  const link = element('a', repo, 'repo-link');
  link.href = `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}`;
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `${repo} repository (opens in a new tab)`);
  return link;
}

async function changeDraftStatus(pr) {
  if (draftChanges.get(pr.id)?.saving) return;
  const toDraft = pr.status === 'OPEN';
  const change = { saving: true, error: '' };
  draftChanges.set(pr.id, change); render();
  try {
    const response = await apiFetch(toDraft ? '/api/pulls/draft' : '/api/pulls/ready', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pr.id }), signal: AbortSignal.timeout(65_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not change the PR status. Please retry.');
    const current = items.find(item => item.id === pr.id);
    if (current) { current.status = data.status; current.updatedAt = data.updatedAt; current.review = data.review; }
    draftChanges.delete(pr.id); render();
    $('summary').append(document.createTextNode(toDraft ? ' · PR converted to draft' : ' · PR ready for review'));
  } catch (error) {
    change.saving = false;
    change.error = error.name === 'TimeoutError' ? 'Status change timed out. Click the status badge to retry or refresh to check its status.' : error.message;
    render();
  }
}

function focusTitleControl(id, selector) {
  [...$('results').querySelectorAll('.pr-row')].find(row => row.dataset.prId === id)?.querySelector(selector)?.focus();
}

function titleEditor(pr) {
  const draft = titleEdits.get(pr.id);
  const form = element('form', undefined, 'title-editor');
  form.setAttribute('aria-label', `Edit title of ${pr.repo} #${pr.number}`);
  const input = element('input');
  input.type = 'text'; input.value = draft.value; input.required = true; input.maxLength = 256;
  input.setAttribute('aria-label', 'Pull request title');
  input.disabled = draft.saving;
  const save = element('button', draft.saving ? 'Saving…' : 'Save');
  save.type = 'submit';
  save.disabled = draft.saving || !draft.value.trim() || draft.value.trim() === draft.expectedTitle;
  const cancel = element('button', 'Cancel');
  cancel.type = 'button'; cancel.disabled = draft.saving;
  const close = () => {
    if (draft.saving) return;
    titleEdits.delete(pr.id); render(); focusTitleControl(pr.id, '.edit-title');
  };
  cancel.addEventListener('click', close);
  input.addEventListener('input', () => {
    draft.value = input.value;
    save.disabled = !input.value.trim() || input.value.trim() === draft.expectedTitle;
  });
  form.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  form.append(input, save, cancel);
  if (draft.error) {
    const error = element('p', draft.error, 'title-error');
    error.setAttribute('role', 'alert'); form.append(error);
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (draft.saving || !draft.value.trim() || draft.value.trim() === draft.expectedTitle) return;
    draft.saving = true; draft.error = ''; render();
    try {
      const response = await apiFetch('/api/pulls/title', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pr.id, title: draft.value.trim(), expectedTitle: draft.expectedTitle }),
        signal: AbortSignal.timeout(65_000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not update the title. Please retry.');
      const current = items.find(item => item.id === pr.id);
      if (current) { current.title = data.title; current.updatedAt = data.updatedAt; }
      titleEdits.delete(pr.id); render();
      $('summary').append(document.createTextNode(' · Title updated'));
      focusTitleControl(pr.id, '.edit-title');
    } catch (error) {
      draft.saving = false;
      draft.error = error.name === 'TimeoutError' ? 'The save timed out. Retry to check and save the title.' : error.message;
      render(); focusTitleControl(pr.id, '.title-editor input');
    }
  });
  return form;
}

function render() {
  const { count, groups } = groupPulls(items, { search: $('search').value, group: $('group').value, sort: $('sort').value });
  updateSummary();
  const fragment = document.createDocumentFragment();
  for (const [name, prs] of groups) {
    const section = element('details');
    const key = `${$('group').value}:${name}`;
    section.open = !collapsed.has(key);
    section.addEventListener('toggle', () => section.open ? collapsed.delete(key) : collapsed.add(key));
    const heading = element('summary');
    if ($('group').value === 'repo') heading.append(repositoryLink(name), document.createTextNode(` (${prs.length})`));
    else heading.textContent = `${labels[name] ?? name} (${prs.length})`;
    section.append(heading);
    const list = element('ul');
    for (const pr of prs) {
      const row = element('li', undefined, 'pr-row');
      row.dataset.prId = pr.id;
      const hasUpdates = hasUnviewedUpdate(pr, viewedUpdates);
      row.classList.toggle('has-updates', hasUpdates);
      const onOpen = event => {
        if ((event.type === 'click' && event.button === 0) || (event.type === 'auxclick' && event.button === 1)) {
          if (event.target.closest('a[data-view-pr][href]')) markViewed(pr);
        }
      };
      row.addEventListener('click', onOpen);
      row.addEventListener('auxclick', onOpen);
      const title = element('a', pr.title, 'pr-title');
      // Only navigate to GitHub, even if an upstream response is malformed.
      try { const url = new URL(pr.url); if (url.protocol === 'https:' && url.hostname === 'github.com') title.href = url.href; } catch { /* No unsafe link. */ }
      title.target = '_blank'; title.rel = 'noopener noreferrer';
      title.dataset.viewPr = '';
      title.setAttribute('aria-label', `${hasUpdates ? 'New updates: ' : ''}${pr.title} (opens in a new tab)`);
      const line = element('div', undefined, 'title-line');
      const feedback = element('span', undefined, 'sr-only');
      feedback.setAttribute('role', 'status');
      if (['OPEN', 'DRAFT'].includes(pr.status) && pr.author.toLowerCase() === viewerLogin.toLowerCase()) {
        const pending = draftChanges.get(pr.id)?.saving ?? false;
        const status = element('button', pending ? 'Updating…' : labels[pr.status], `badge ${pr.status.toLowerCase()} draft-action`);
        status.type = 'button'; status.disabled = pending;
        status.title = pr.status === 'OPEN' ? 'Convert to draft' : 'Mark ready for review';
        status.setAttribute('aria-label', pr.status === 'OPEN' ? `Convert ${pr.title} to draft` : `Mark ${pr.title} ready for review`);
        status.addEventListener('click', () => changeDraftStatus(pr));
        line.append(status);
      } else line.append(badge(labels[pr.status], pr.status));
      if (title.hasAttribute('href')) {
        const copy = element('button', undefined, 'copy-link');
        copy.type = 'button';
        copy.title = 'Copy PR link';
        copy.setAttribute('aria-label', `Copy link to ${pr.title}`);
        const copyIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 16 16', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) copyIcon.setAttribute(key, value);
        const copyPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        copyPath.setAttribute('d', 'M5 3V2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-1 M2 5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z');
        copyIcon.append(copyPath);
        copy.append(copyIcon);
        let feedbackTimer;
        copy.addEventListener('click', async () => {
          clearTimeout(feedbackTimer);
          try {
            await navigator.clipboard.writeText(title.href);
            copy.textContent = '✓';
            copy.title = 'PR link copied';
            feedback.textContent = 'PR link copied';
          } catch {
            copy.textContent = '!';
            copy.title = 'Could not copy. Allow clipboard access and retry.';
            feedback.textContent = copy.title;
          }
          feedbackTimer = setTimeout(() => {
            copy.replaceChildren(copyIcon);
            copy.title = 'Copy PR link';
            feedback.textContent = '';
          }, 2000);
        });
        line.append(copy);
        const files = element('a', undefined, 'pr-files');
        const url = new URL(title.href);
        url.pathname = `${url.pathname.replace(/\/$/, '')}/files`;
        url.search = ''; url.hash = '';
        files.href = url.href;
        files.target = '_blank'; files.rel = 'noopener noreferrer';
        files.dataset.viewPr = '';
        files.title = 'View code changes (opens in a new tab)';
        files.setAttribute('aria-label', `View code changes for ${pr.title} (opens in a new tab)`);
        // GitHub Octicons file-diff (MIT); see THIRD_PARTY_NOTICES.
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 16 16');
        icon.setAttribute('width', '16');
        icon.setAttribute('height', '16');
        icon.setAttribute('fill', 'currentColor');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('focusable', 'false');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073ZM8 3.25a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0V7h-1.5a.75.75 0 0 1 0-1.5h1.5V4A.75.75 0 0 1 8 3.25Zm-3 8a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z');
        icon.append(path);
        files.append(icon);
        line.append(files);
      }
      line.append(title);
      if (pr.author.toLowerCase() === viewerLogin.toLowerCase()) {
        const edit = element('button', undefined, 'edit-title');
        edit.type = 'button'; edit.title = 'Edit PR title';
        edit.setAttribute('aria-label', `Edit title of ${pr.title}`);
        edit.disabled = titleEdits.get(pr.id)?.saving ?? false;
        const pencil = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 16 16', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) pencil.setAttribute(key, value);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M10 3l3 3M2 11l-1 4 4-1L14 5a2.12 2.12 0 0 0-3-3Z');
        pencil.append(path); edit.append(pencil);
        edit.addEventListener('click', () => {
          if (!titleEdits.has(pr.id)) titleEdits.set(pr.id, { value: pr.title, expectedTitle: pr.title, saving: false, error: '' });
          render(); focusTitleControl(pr.id, '.title-editor input');
        });
        line.append(edit);
      }
      const meta = element('div', undefined, 'meta');
      let checks = badge(labels[pr.checks] ?? pr.checks, pr.checks);
      if (pr.checks === 'FAILURE' && title.hasAttribute('href')) {
        checks = element('a', labels[pr.checks], 'badge failure');
        const url = new URL(title.href);
        url.pathname = `${url.pathname.replace(/\/$/, '')}/checks`;
        url.search = ''; url.hash = '';
        checks.href = url.href;
        checks.target = '_blank'; checks.rel = 'noopener noreferrer';
        checks.dataset.viewPr = '';
        checks.title = 'View checks (opens in a new tab)';
        checks.setAttribute('aria-label', `Checks failed: view checks for ${pr.title} (opens in a new tab)`);
      }
      const author = usernameBadge(pr.author);
      const repo = element('span');
      repo.append(repositoryLink(pr.repo), document.createTextNode(` #${pr.number}`));
      meta.append(repo, author, checks);
      if (pr.branch) {
        const branch = element('button', undefined, 'branch-copy');
        branch.type = 'button';
        branch.title = `Copy branch name: ${pr.branch}`;
        branch.setAttribute('aria-label', branch.title);
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 16 16', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) icon.setAttribute(key, value);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M5 3V2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-1 M2 5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z');
        icon.append(path);
        const symbol = element('span', undefined, 'branch-copy-symbol');
        symbol.setAttribute('aria-hidden', 'true'); symbol.append(icon);
        branch.append(element('span', pr.branch, 'branch-name'), symbol);
        let timer;
        branch.addEventListener('click', async () => {
          clearTimeout(timer);
          try {
            await navigator.clipboard.writeText(pr.branch);
            symbol.textContent = '✓';
            branch.title = 'Branch name copied';
            feedback.textContent = 'Branch name copied';
          } catch {
            symbol.textContent = '!';
            branch.title = 'Could not copy. Allow clipboard access and retry.';
            feedback.textContent = branch.title;
          }
          timer = setTimeout(() => {
            symbol.replaceChildren(icon);
            branch.title = `Copy branch name: ${pr.branch}`;
            feedback.textContent = '';
          }, 2000);
        });
        meta.append(branch);
      }
      if (pr.review !== 'NONE') {
        const review = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' };
        meta.append(badge(review[pr.review] ?? pr.review, pr.review));
      }
      const age = relativeTime(pr.updatedAt);
      const time = element('time', undefined, 'updated-time');
      time.dateTime = pr.updatedAt;
      time.title = `Updated ${new Date(pr.updatedAt).toLocaleString()}`;
      time.setAttribute('aria-label', `Updated ${age}`);
      const clock = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [key, value] of Object.entries({ viewBox: '0 0 16 16', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) clock.setAttribute(key, value);
      const face = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      face.setAttribute('cx', '8'); face.setAttribute('cy', '8'); face.setAttribute('r', '6');
      const hands = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hands.setAttribute('d', 'M8 4v4l2.5 1.5');
      clock.append(face, hands);
      time.append(clock, document.createTextNode(age));
      meta.append(time, element('span', `+${pr.additions}`, 'additions'), element('span', `−${pr.deletions}`, 'deletions'));
      for (const label of pr.labels) meta.append(badge(label, 'label'));
      const content = element('div', undefined, 'pr-content');
      content.append(line);
      if (draftChanges.get(pr.id)?.error) {
        const error = element('p', draftChanges.get(pr.id).error, 'draft-error');
        error.setAttribute('role', 'alert'); content.append(error);
      }
      if (titleEdits.has(pr.id) && pr.author.toLowerCase() === viewerLogin.toLowerCase()) content.append(titleEditor(pr));
      content.append(meta, feedback);
      const reviewers = element('div', undefined, 'reviewers');
      reviewers.setAttribute('role', 'group');
      reviewers.setAttribute('aria-label', 'Reviewers');
      const reviewStates = {
        REQUESTED: ['Awaiting review', 'review_required', '◷'],
        APPROVED: ['Approved', 'approved', '✓'],
        CHANGES_REQUESTED: ['Changes requested', 'changes_requested', '!'],
        COMMENTED: ['Commented', 'commented', '⋯'],
        DISMISSED: ['Review dismissed', 'dismissed', '−'],
      };
      for (const reviewer of pr.reviewers ?? []) {
        const [description, kind, symbol] = reviewStates[reviewer.state] ?? [reviewer.state, 'none', '·'];
        const person = element('span', undefined, 'reviewer');
        person.title = `${reviewer.name}: ${description}`;
        person.setAttribute('aria-label', `${reviewer.name}: ${description}`);
        const status = badge(symbol, kind);
        status.classList.add('review-status');
        status.setAttribute('aria-hidden', 'true');
        person.append(usernameBadge(reviewer.name), status);
        reviewers.append(person);
      }
      if (pr.reviewersTruncated && title.hasAttribute('href')) {
        const all = element('a', 'View all on GitHub');
        all.href = title.href; all.target = '_blank'; all.rel = 'noopener noreferrer';
        all.dataset.viewPr = '';
        reviewers.append(all);
      }
      row.append(content);
      if (pr.reviewers?.length || pr.reviewersTruncated) row.append(reviewers);
      list.append(row);
    }
    section.append(list); fragment.append(section);
  }
  if (!count && !loading) fragment.append(element('p', items.length ? 'No loaded pull requests match your search.' : 'No pull requests found for these filters.', 'empty'));
  $('results').replaceChildren(fragment);
  $('results').setAttribute('aria-busy', String(loading));
  $('more').hidden = !more; $('more').disabled = loading;
  $('refresh').disabled = loading;
}

async function load({ append = false, refresh = false } = {}) {
  controller?.abort(); controller = new AbortController();
  const current = ++generation;
  if (!append) { items = []; total = 0; cursor = null; more = false; limited = false; }
  loading = true; $('error').hidden = true; render();
  const query = new URLSearchParams({ scope: $('scope').value, state: $('state').value });
  if (append && cursor) query.set('cursor', cursor);
  if (refresh) query.set('refresh', '1');
  try {
    const response = await apiFetch(`/api/pulls?${query}`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load pull requests.');
    if (current !== generation) return;
    const nextViewedKey = `gh-pull.${demoMode ? 'demo.' : ''}viewed.v1:${data.viewer.toLowerCase()}`;
    if (viewedKey !== nextViewedKey) {
      viewedKey = nextViewedKey;
      viewedUpdates = { ...demoClient?.initialViewed };
      titleEdits.clear();
      draftChanges.clear();
    }
    viewerLogin = data.viewer;
    viewedUpdates = { ...viewedUpdates, ...readViewedUpdates() };
    items = [...new Map([...items, ...data.items].map(pr => [pr.id, pr])).values()];
    nameColors = assignNameColors(items.flatMap(pr => [pr.author, ...(pr.reviewers ?? []).map(reviewer => reviewer.name)]), nameColors);
    try { localStorage.setItem(nameColorKey, JSON.stringify(nameColors)); } catch { /* Keep assignments stable for this session. */ }
    total = data.total; cursor = data.pageInfo.endCursor; more = data.pageInfo.hasNextPage;
    limited = data.limited;
    if (limited && items.length >= 1000) more = false;
    $('viewer').textContent = demoMode ? `${data.viewer} · demo` : data.viewer;
    $('updated').textContent = `Fetched ${new Date().toLocaleTimeString()}.`;
  } catch (error) {
    if (current !== generation || error.name === 'AbortError') return;
    $('error').replaceChildren(element('span', error.message + ' '));
    const retry = element('button', 'Retry'); retry.type = 'button';
    retry.addEventListener('click', () => load({ append, refresh: true }));
    $('error').append(retry); $('error').hidden = false;
  } finally { if (current === generation) { loading = false; render(); } }
}

function saveFilters() {
  const query = new URLSearchParams(controls.map(id => [id, $(id).value]).filter(([, value]) => value));
  if (demoMode) query.set('demo', '1');
  history.replaceState(null, '', `?${query}`);
}
$('filters').addEventListener('submit', event => event.preventDefault());
for (const id of controls) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => {
  saveFilters();
  if (id === 'scope' || id === 'state') load(); else render();
});
$('refresh').addEventListener('click', () => load({ refresh: true }));
$('more').addEventListener('click', () => load({ append: true }));
load();
