import { html, render } from './vendor/lit-html.js';
import { actionButton, formField, formError, formActions } from './controls.js';
import { iconTemplate as icon } from './templates.js';
import { labels } from './model.js';
import { createPopover } from './popover.js';

export function createLifecycleControls({ changes, submit, changeDraft, onClose }) {
  let active;
  const popover = createPopover({ id: 'pr-lifecycle', className: 'review-popover', label: 'Pull request status', onClose() {
    if (active && !changes.get(active.id)?.saving) {
      const id = active.id; active = null; changes.delete(id); onClose(id);
    }
  } });
  function content() {
    const pr = active, draft = pr && changes.get(pr.id);
    if (!draft) return;
    render(draft.confirm ? html`<form @submit=${event => {
      event.preventDefault(); if (!draft.saving) void submit(pr, draft, 'close');
    }}>
      <h2>Close this pull request?</h2>
      <p class="form-description">This closes the PR without merging. Its branch and discussion will remain.</p>
      <label class="form-label">Comment <span class="review-required">Optional</span>
        ${formField({ label: 'Comment', value: draft.value, multiline: true, maxLength: 4000, required: false, disabled: draft.saving,
          onInput: value => { draft.value = value; content(); } })}
      </label>
      ${formError(draft.error)}
      ${formActions({ saving: draft.saving, submitLabel: 'Close pull request', pendingLabel: 'Closing…', onCancel: popover.close, tone: 'danger' })}
    </form>` : html`<div class="popover-menu">
      ${pr.status === 'CLOSED' ? html`<button class="popover-menu-item" type="button" ?disabled=${draft.saving} @click=${() => submit(pr, draft, 'reopen')}>${draft.saving ? 'Reopening…' : 'Reopen pull request'}</button>` : html`
        <button class="popover-menu-item" type="button" @click=${() => { popover.close(); void changeDraft(pr); }}>${pr.status === 'DRAFT' ? 'Mark ready for review' : 'Convert to draft'}</button>
        ${pr.canClose ? html`<button class="popover-menu-item destructive" type="button" @click=${() => { draft.confirm = true; content(); popover.panel.querySelector('textarea').focus(); }}>Close pull request…</button>` : ''}`}
      ${formError(draft.error)}
    </div>`, popover.panel);
  }
  return {
    reset() { popover.close(); active = null; },
    recover() { content(); if (active && !popover.isOpen) popover.panel.showPopover(); },
    reconcile(ids) { if (active && !ids.has(active.id) && !changes.get(active.id)?.saving) popover.close(); },
    button(pr, disabled) {
      if (active?.id === pr.id) { active = pr; content(); }
      return actionButton({ className: `badge ${pr.status.toLowerCase()} lifecycle-action`, label: `Status options for ${pr.title}`,
        popover: popover.panel, expanded: popover.pullId === pr.id, disabled: disabled || [...changes.values()].some(change => change.saving),
        content: html`${labels[pr.status]}${icon('chevron-down', 12)}`,
        onClick: event => {
          if (active?.id !== pr.id) {
            if (active) changes.delete(active.id);
            active = pr; changes.set(pr.id, { value: '', confirm: false, saving: false, error: '' });
          }
          popover.attach(event.currentTarget); content();
        } });
    },
  };
}
