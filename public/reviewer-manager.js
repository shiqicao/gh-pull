import { html, render, nothing, repeat } from './vendor/lit-html.js';
import { actionButton, formField, formError } from './controls.js';
import { createPopover } from './popover.js';
import { githubUrl, iconTemplate, reviewStatus } from './templates.js';
import { reviewStates } from './model.js';

export function createReviewerManager({ changes, search, submit, onClose, renderName }) {
  let active, timer, controller, generation = 0;
  function cancelSearch() { clearTimeout(timer); controller?.abort(); generation++; }
  const popover = createPopover({ id: 'manage-reviewers', className: 'reviewer-manager', label: 'Manage reviewers', align: 'end',
    onClose() {
      cancelSearch();
      if (active && !changes.get(active.id)?.saving) {
        const id = active.id; active = null; changes.delete(id); onClose(id);
      }
    },
  });
  const initial = () => ({ query: '', results: [], loading: true, saving: false, error: '', searchError: '', limited: false, pending: new Map() });
  function change(reviewer, action) {
    const draft = changes.get(active.id);
    if (draft.saving) return;
    const key = reviewer.name.toLowerCase();
    if (draft.pending.has(key)) draft.pending.delete(key);
    else draft.pending.set(key, { ...reviewer, action, kind: reviewer.kind ?? (reviewer.name.includes('/') ? 'team' : 'user') });
    draft.error = ''; content();
  }
  async function load() {
    if (!active) return;
    const id = active.id, draft = changes.get(id), current = ++generation;
    controller?.abort(); controller = new AbortController();
    draft.loading = true; draft.searchError = ''; content();
    try {
      const data = await search(id, draft.query, controller.signal);
      if (generation !== current || active?.id !== id) return;
      draft.results = data.reviewers; draft.limited = data.limited;
    } catch (error) {
      if (generation !== current || active?.id !== id) return;
      draft.searchError = error.message;
    } finally {
      if (generation === current && active?.id === id) { draft.loading = false; content(); }
    }
  }
  function row(reviewer, current = false) {
    const draft = changes.get(active.id), pending = reviewer.state === 'REQUESTED';
    const staged = draft.pending.get(reviewer.name.toLowerCase());
    const [label, kind, symbol] = reviewStates[reviewer.state] ?? ['Not requested', 'none', '·'];
    return html`<li class="reviewer-choice"><span class="reviewer-choice-name">${renderName(reviewer.name)}
      <small>${staged ? (staged.action === 'remove' ? 'Will remove request' : 'Will request review') : current ? label : reviewer.displayName || (reviewer.kind === 'team' ? 'Team' : 'User')}</small></span>
      ${current ? reviewStatus(symbol, kind) : nothing}
      <button type="button" class=${pending ? 'reviewer-remove' : ''} ?disabled=${draft.saving}
        aria-label=${`${staged ? 'Undo change for' : pending ? 'Remove request for' : current ? 'Re-request review from' : 'Request review from'} ${reviewer.name}`}
        @click=${() => change(reviewer, pending ? 'remove' : 'request')}>${staged ? 'Undo' : pending ? 'Remove' : current ? 'Re-request' : 'Request'}</button></li>`;
  }
  function content() {
    if (!active) return;
    const draft = changes.get(active.id);
    if (!draft) return;
    const current = active.reviewers ?? [], existing = new Set(current.map(r => r.name.toLowerCase()));
    const query = draft.query.trim().replace(/^@/, '');
    const added = [...draft.pending.values()].filter(r => !existing.has(r.name.toLowerCase()));
    const shown = new Set([...existing, ...added.map(r => r.name.toLowerCase())]);
    const results = draft.results.filter(r => !shown.has(r.name.toLowerCase()));
    // Allow exact GitHub logins and org/team slugs beyond the suggestion window.
    const exact = /^[a-z0-9][a-z0-9-]{0,99}(\/[a-z0-9][a-z0-9-]{0,99})?$/i.test(query) &&
      query.toLowerCase() !== active.author.toLowerCase() && !shown.has(query.toLowerCase()) && !results.some(r => r.name.toLowerCase() === query.toLowerCase());
    render(html`<div class="reviewer-manager-heading"><h2>Reviewers</h2><button type="button" class="icon-button" aria-label="Close reviewer manager" @click=${popover.close}>×</button></div>
      <p class="form-description">Request a review from a person or an organization team.</p>
      <label class="form-label">Search people or enter org/team
      ${formField({ label: 'Search reviewers or enter org/team', value: draft.query, disabled: draft.saving, required: false, maxLength: 100,
        onInput(value) { draft.query = value; draft.results = []; cancelSearch(); draft.loading = true; content(); timer = setTimeout(load, 250); } })}</label>
      ${formError(draft.error)}
      ${draft.saving ? html`<p role="status">Updating reviewers…</p>` : nothing}
      ${current.length ? html`<h3>Current reviewers</h3><ul class="reviewer-choices">${repeat(current, r => r.name, r => row(r, true))}</ul>` : html`<p class="form-description">No reviewers yet.</p>`}
      ${active.reviewersTruncated ? html`<p class="form-description">Some reviewers are not shown. <a href=${githubUrl(active.url)} target="_blank" rel="noopener noreferrer">View all on GitHub ↗</a></p>` : nothing}
      ${added.length ? html`<h3>Pending requests</h3><ul class="reviewer-choices">${repeat(added, r => r.name, r => row(r))}</ul>` : nothing}
      <h3>${query ? 'Search results' : 'Suggested reviewers'}</h3>
      ${draft.loading ? html`<p role="status">Searching reviewers…</p>` : nothing}
      ${formError(draft.searchError)}
      <ul class="reviewer-choices">${repeat(results, r => r.name, r => row(r))}
        ${exact ? row({ name: query, kind: query.includes('/') ? 'team' : 'user', displayName: 'Exact name · GitHub will check access' }) : nothing}</ul>
      ${!draft.loading && !draft.searchError && !results.length && !exact ? html`<p class="form-description">${query ? 'No matching reviewers.' : 'No suggestions. Enter a GitHub username or org/team.'}</p>` : nothing}
      ${draft.limited ? html`<p class="form-description">More results available. Narrow your search.</p>` : nothing}
      <p class="reviewer-manager-note">Removing a request keeps existing reviews and comments.</p>
      <div class="form-actions reviewer-manager-actions">
        <button type="button" ?disabled=${draft.saving} @click=${popover.close}>Cancel</button>
        <button type="button" ?disabled=${draft.saving || !draft.pending.size}
          @click=${() => { cancelSearch(); draft.loading = false; void submit(active, draft.pending); }}>
          ${draft.saving ? 'Applying…' : `Apply changes${draft.pending.size ? ` (${draft.pending.size})` : ''}`}</button>
      </div>`, popover.panel);
  }
  return {
    reset() { cancelSearch(); popover.close(); if (active) changes.delete(active.id); active = null; },
    recover() { content(); if (active && !popover.isOpen) popover.panel.showPopover(); },
    updated(pr) { if (!active || active.id !== pr.id) return; active = pr; changes.set(pr.id, initial()); content(); if (!popover.isOpen) { changes.delete(pr.id); active = null; return; } void load(); },
    reconcile(ids, items) { if (active && (!ids.has(active.id) || items.find(pr => pr.id === active.id)?.status !== 'OPEN') && !changes.get(active.id)?.saving) this.reset(); },
    button(pr, busy) {
      if (active?.id === pr.id) { active = pr; content(); }
      return actionButton({ className: 'icon-button reviewer-manage', label: `Manage reviewers for ${pr.repo} #${pr.number}`,
        title: pr.status === 'DRAFT' ? 'Mark this PR ready before requesting reviews' : 'Manage reviewers',
        popover: popover.panel, expanded: popover.pullId === pr.id, disabled: busy || [...changes.values()].some(draft => draft.saving) || pr.status !== 'OPEN',
        content: iconTemplate('reviewers'),
        onClick(event) {
          if (active?.id !== pr.id) {
            cancelSearch(); if (active) changes.delete(active.id);
            active = pr; changes.set(pr.id, initial()); void load();
          }
          popover.attach(event.currentTarget); content();
        },
      });
    },
  };
}
