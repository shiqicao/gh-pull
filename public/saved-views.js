import { html, render, repeat, nothing } from './vendor/lit-html.js';
import { formField, formError, formActions } from './controls.js';
import { createPopover } from './popover.js';
import { icon } from './ui.js';
import { queryError } from './query.js';

export function createSavedViews({ request, getQuery, getAppliedQuery, getGroup, apply, enabled, onOpen = () => {} }) {
  const root = document.getElementById('saved-views');
  const footer = document.getElementById('saved-view-footer');
  root.hidden = footer.hidden = !enabled;
  let focusSelected = false;
  const popover = createPopover({ id: 'saved-views-panel', className: 'saved-views-popover', label: 'Manage saved view', onClose: () => {
    if (focusSelected) { focusSelected = false; root.querySelector('.saved-view-pill[aria-pressed="true"]')?.focus(); }
  } });
  let views = [], account, activeId, busy = false, loading = false, generation = 0;
  let popupTrigger, overflow = [];
  let usageQueue = Promise.resolve(), usageWarning = '';
  let sessionOrder = [];
  let mode, name = '', formMessage = '', failure = '', pending, notice;
  const active = () => views.find(view => view.id === activeId);
  const unapplied = () => getQuery() !== getAppliedQuery();
  const canSave = () => !busy && !loading && account && !unapplied() && !queryError(getAppliedQuery());
  const groupName = group => ({ repo: 'Repository', author: 'Author', status: 'Status', checks: 'Checks', none: 'No grouping' })[group ?? 'repo'];
  const differs = view => view && (view.query !== getAppliedQuery() || (view.group ?? 'repo') !== getGroup());
  const snapshot = () => ({ activeId, query: getAppliedQuery(), draft: getQuery(), group: getGroup() });
  let previousSearch;
  function update() {
    const search = JSON.stringify([getQuery(), getAppliedQuery(), getGroup()]);
    if (previousSearch !== search) notice = null;
    previousSearch = search;
    const view = active(), edited = differs(view);
    let message, action, actionLabel, tone = '';
    if (loading) message = 'Loading saved views…';
    else if (busy) message = 'Saving view…';
    else if (unapplied()) message = 'Apply your query with Search or Enter before saving.';
    else if (failure) {
      message = failure; tone = 'error'; actionLabel = 'Retry';
      action = () => pending ? void mutate(pending) : void load();
    } else if (notice) { message = notice.text; action = notice.undo; actionLabel = 'Undo'; }
    else if (edited) {
      const changed = view.query !== getAppliedQuery() ? ((view.group ?? 'repo') !== getGroup() ? 'query and grouping' : 'query') : 'grouping';
      message = `Edited ${changed}.`;
      tone = 'edited'; actionLabel = 'Revert'; action = () => { apply(view.query, view.group ?? 'repo'); update(); };
    } else if (usageWarning) { message = usageWarning; tone = 'error'; }
    else message = view ? `Showing saved view “${view.name}”.` : 'Save this search to reuse its query and grouping.';
    render(html`<div class="saved-view-pills" role="group" aria-label="Saved views">
        <span class="saved-views-label">Views</span>
        ${!views.length ? html`<span class="saved-views-empty">None saved yet</span>` : repeat(views, view => view.id, view => html`
          <button type="button" class="saved-view-pill" data-view-id=${view.id} aria-pressed=${String(view.id === activeId)} ?disabled=${busy || loading}
            aria-haspopup=${view.id === activeId ? 'dialog' : nothing} aria-controls=${view.id === activeId ? popover.panel.id : nothing}
            aria-expanded=${view.id === activeId ? String(popover.isOpen && popupTrigger?.dataset.viewId === view.id) : nothing}
            popovertarget=${view.id === activeId ? popover.panel.id : nothing}
            data-tooltip=${view.id === activeId ? `Rename or delete “${view.name}”` : `${view.query} · Group by: ${groupName(view.group)}`}
            @click=${event => { event.preventDefault(); view.id === activeId ? open('menu', event.currentTarget) : select(view); }}>
            <span>${view.name}</span><span class="saved-view-indicators" aria-hidden="true"><span class=${`saved-view-dot ${view.id === activeId && differs(view) ? 'edited' : ''}`}></span><span class="saved-view-arrow">${view.id === activeId ? icon('chevron-down', 12) : nothing}</span></span>
          </button>`)}
        <button type="button" class="saved-view-more" aria-haspopup="dialog" aria-controls=${popover.panel.id}
          popovertarget=${popover.panel.id}
          aria-expanded=${String(popover.isOpen && mode === 'more')} ?disabled=${busy || loading}
          @click=${event => { event.preventDefault(); open('more', event.currentTarget); }}><span class="saved-view-more-label"></span><span class="saved-view-arrow" aria-hidden="true">${icon('chevron-down', 12)}</span></button>
      </div>
      `, root);
    render(html`<div id="saved-view-status" class=${`saved-view-status ${tone}`} role="status" aria-live="polite">
      <span>${message}</span>${action ? html`<button type="button" class="saved-view-status-action" ?disabled=${busy} @click=${action}>${actionLabel}</button>` : nothing}
    </div>
    <div class="saved-view-actions">
      <button id="save-view-new" type="button" ?disabled=${!canSave()} @click=${event => open('save', event.currentTarget)}>Save as new view</button>
      <button id="save-view" type="button" class="saved-view-save" ?disabled=${!canSave() || !edited} aria-describedby="saved-view-status"
        @click=${saveChanges}>${busy ? 'Saving…' : 'Save changes'}</button>
    </div>`, footer);
    layoutPills();
    if (popover.isOpen) content();
  }
  function layoutPills() {
    const row = root.querySelector('.saved-view-pills');
    if (!row || !row.clientWidth) return;
    const pills = [...row.querySelectorAll('.saved-view-pill')], more = row.querySelector('.saved-view-more');
    const label = row.querySelector('.saved-views-label');
    // Measure real rendered labels, including the current font and zoom level.
    for (const pill of pills) { pill.hidden = false; pill.style.maxWidth = ''; }
    more.hidden = false;
    more.firstElementChild.textContent = `More (${views.length})`;
    const gap = 6, available = row.clientWidth - label.getBoundingClientRect().width - gap;
    const moreWidth = more.getBoundingClientRect().width;
    const widths = pills.map(pill => pill.getBoundingClientRect().width);
    let visible = [], used = 0;
    if (widths.reduce((sum, width) => sum + width + gap, -gap) <= available) visible = pills.map((_, i) => i);
    else {
      const budget = Math.max(0, available - moreWidth - gap);
      for (let i = 0; i < pills.length; i++) {
        const required = widths[i] + (visible.length ? gap : 0);
        if (used + required > budget) break;
        visible.push(i); used += required;
      }
      const selected = pills.findIndex(pill => pill.dataset.viewId === activeId);
      if (selected !== -1 && !visible.includes(selected)) {
        while (visible.length && used + widths[selected] + gap > budget) {
          used -= widths[visible.pop()] + (visible.length ? gap : 0);
        }
        if (!visible.length) pills[selected].style.maxWidth = `${budget}px`;
        visible.push(selected);
      }
    }
    const visibleSet = new Set(visible);
    pills.forEach((pill, i) => { pill.hidden = !visibleSet.has(i); });
    overflow = views.filter(view => !pills.some((pill, i) => visibleSet.has(i) && pill.dataset.viewId === view.id));
    more.hidden = !overflow.length;
    more.firstElementChild.textContent = `More (${overflow.length})`;
    if (popover.isOpen) {
      if (mode === 'more' && !overflow.length) popover.close();
      else if (mode === 'more') content();
      else popover.reposition();
    }
  }
  function select(view) {
    if (busy || loading) return;
    const fromOverflow = mode === 'more' && popover.isOpen;
    const old = snapshot(), oldView = active();
    const discard = unapplied() || differs(oldView);
    activeId = view.id; failure = ''; pending = null; focusSelected = fromOverflow; popover.close();
    apply(view.query, view.group ?? 'repo');
    recordLoad(view);
    if (discard) notice = { text: oldView ? `Discarded edits to “${oldView.name}”.` : 'Discarded unapplied query.', undo: () => {
      activeId = views.some(v => v.id === old.activeId) ? old.activeId : null;
      apply(old.query, old.group, old.draft); notice = null; update();
    } };
    update();
    if (fromOverflow) root.querySelector('.saved-view-pill[aria-pressed="true"]')?.focus();
  }
  function recordLoad(view) {
    const current = generation, input = { action: 'load', account, id: view.id };
    usageQueue = usageQueue.then(async () => {
      if (current !== generation) return;
      try {
        const data = await request(input);
        if (current !== generation) return;
        const saved = data.views.find(v => v.id === view.id), existing = views.find(v => v.id === view.id);
        if (saved && existing) for (const key of ['loadCount', 'createdAt', 'lastEditedAt', 'lastLoadedAt']) existing[key] = saved[key];
        const hadWarning = Boolean(usageWarning);
        usageWarning = '';
        if (hadWarning) update();
      } catch {
        if (current === generation) { usageWarning = 'View loaded, but its usage could not be saved.'; update(); }
      }
    });
  }
  function open(nextMode, trigger) {
    if (busy || loading) return;
    if (['menu', 'more'].includes(nextMode) && popover.isOpen && popupTrigger === trigger) { popover.close(); return; }
    if (nextMode === 'save' && !canSave()) return;
    onOpen(); mode = nextMode; name = nextMode === 'rename' ? active()?.name ?? '' : ''; formMessage = '';
    popupTrigger = trigger; content();
    if (!popover.isOpen) popover.panel.showPopover();
    popover.panel.querySelector('input, button')?.focus();
  }
  function content() {
    const view = active(), nameForm = mode === 'save' || mode === 'rename';
    popover.panel.classList.toggle('saved-views-menu', !nameForm);
    popover.panel.classList.toggle('saved-views-rename', mode === 'rename');
    popover.panel.classList.toggle('saved-views-overflow', mode === 'more');
    if (popupTrigger) popover.attach(popupTrigger, { anchor: mode === 'save' ? footer : popupTrigger, align: ['save', 'more'].includes(mode) ? 'end' : 'start' });
    render(mode === 'more' ? html`<div class="popover-menu" aria-label="More saved views">${repeat(overflow, view => view.id, view => html`<button type="button" class="popover-menu-item" data-tooltip=${`${view.query} · Group by: ${groupName(view.group)}`} @click=${() => select(view)}>${view.name}</button>`)}</div>` : mode === 'menu' ? html`<div class="popover-menu">
      <button type="button" class="popover-menu-item" @click=${() => { mode = 'rename'; name = view.name; content(); popover.panel.querySelector('input').focus(); }}>Rename…</button>
      <button type="button" class="popover-menu-item destructive" @click=${() => { mode = 'delete'; content(); }}>Delete…</button>
    </div>` : html`<form @submit=${event => {
      event.preventDefault();
      if (busy) return;
      if (mode === 'save' && !canSave()) return;
      if (mode !== 'delete' && !name.trim()) return;
      const job = { action: mode, account, id: view?.id, name: name.trim(), query: getAppliedQuery(), group: getGroup() };
      if (mode === 'delete') job.removed = { ...view, position: views.indexOf(view) };
      void mutate(job);
    }}>
      ${mode === 'delete' ? html`<p class="form-description">Delete “${view?.name}”? The current search stays on screen.</p>` : html`
        <label class="form-label">${mode === 'save' ? 'Save as new view' : 'Rename view'}${formField({ label: 'View name', value: name, maxLength: 80, disabled: busy, onInput: value => { name = value; content(); } })}</label>`}
      ${mode === 'save' ? html`<div class="saved-view-summary"><div>Saves the current search:</div><code>${getAppliedQuery()}</code><div>Group by: <span>${groupName(getGroup())}</span></div></div>
        ${unapplied() ? html`<p class="form-description">Apply your query with Search or Enter before saving.</p>` : nothing}` : nothing}
      ${formError(formMessage)}
      ${formActions({ saving: busy, disabled: mode === 'save' ? !canSave() || !name.trim() : mode === 'rename' && !name.trim(),
        submitLabel: mode === 'save' ? 'Save view' : mode === 'rename' ? 'Rename' : 'Delete view', pendingLabel: 'Saving…',
        tone: mode === 'delete' ? 'danger' : 'default', onCancel: popover.close })}
    </form>`, popover.panel);
  }
  function saveChanges() {
    const view = active();
    if (!canSave() || !differs(view)) return;
    onOpen();
    void mutate({ action: 'update', account, id: view.id, name: view.name, query: getAppliedQuery(), group: getGroup() });
  }
  async function mutate(job) {
    if (busy || job.account !== account) return;
    if (['save', 'update', 'restore'].includes(job.action) && unapplied()) return;
    const current = generation;
    busy = true; failure = ''; formMessage = ''; pending = job; notice = null; update();
    try {
      await usageQueue;
      if (job.action === 'delete') job.removed = { ...job.removed, ...views.find(view => view.id === job.id) };
      const { removed, ...input } = job;
      if (current !== generation) return;
      const data = await request(input);
      if (current !== generation) return;
      for (const view of data.views) if (!sessionOrder.includes(view.id)) sessionOrder.push(view.id);
      views = data.views.sort((a, b) => sessionOrder.indexOf(a.id) - sessionOrder.indexOf(b.id)); pending = null; popover.close();
      if (job.action === 'save') activeId = views.find(v => v.name.toLowerCase() === job.name.toLowerCase())?.id;
      if (job.action === 'restore') activeId = job.id;
      if (job.action === 'delete') {
        activeId = null;
        notice = { text: `Deleted “${removed.name}”.`, undo: () => void mutate({ ...removed, action: 'restore', account }) };
      } else notice = { text: `${job.action === 'rename' ? 'Renamed to' : job.action === 'restore' ? 'Restored' : 'Saved'} “${job.name}”.` };
    } catch (error) {
      if (current !== generation) return;
      failure = `Couldn't save “${job.name}”. Your edits are kept. ${error.message}`;
      formMessage = error.message;
    } finally { if (current === generation) { busy = false; update(); } }
  }
  async function load() {
    const current = ++generation, initialQuery = getAppliedQuery(), initialGroup = getGroup();
    loading = true; failure = ''; update();
    try {
      const data = await request();
      if (current !== generation) return;
      account = data.account; views = data.views;
      sessionOrder = views.map(view => view.id); usageWarning = '';
      activeId = views.find(view => view.query === initialQuery && (view.group ?? 'repo') === initialGroup)?.id;
    } catch (error) { if (current === generation) failure = `Could not load saved views. ${error.message}`; }
    finally { if (current === generation) { loading = false; update(); } }
  }
  document.addEventListener('keydown', event => {
    if (!enabled || !root.isConnected || root.closest('[hidden]') || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    if (!canSave() || popover.isOpen) return;
    if (active()) saveChanges(); else open('save', document.getElementById('save-view-new'));
  });
  if (enabled) {
    const observer = new ResizeObserver(layoutPills);
    observer.observe(root);
    void document.fonts.ready.then(layoutPills);
    void load();
  }
  return { update, reset({ reload = false } = {}) { generation++; views = []; sessionOrder = []; usageWarning = ''; account = activeId = null; busy = loading = false; failure = ''; pending = notice = null; popover.close(); update(); if (reload && enabled) void load(); } };
}
