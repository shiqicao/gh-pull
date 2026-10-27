import { actionButton, formField, formError, formActions } from './controls.js';
import { html, render } from './vendor/lit-html.js';
import { githubUrl, reviewStatus, iconTemplate as icon } from './templates.js';
import { createPopover } from './popover.js';

export function createReviewControls({ changes, submit, onClose }) {
  let active;
  const popover = createPopover({ id: 'review-actions', className: 'review-popover', label: 'Your approval', align: 'end',
    onClose: () => {
      if (active && !changes.get(active.pr.id)?.saving) {
        const id = active.pr.id; active = null; changes.delete(id); onClose(id);
      }
    },
  });
  function content() {
    if (!active) return;
    const { pr, reviewer } = active, draft = changes.get(pr.id);
    if (!draft) return;
    render(draft.confirm ? html`<form @submit=${event => {
      event.preventDefault();
      if (!draft.saving && draft.value.trim()) void submit(pr, draft);
    }}>
      <h2>Revoke your approval?</h2>
      <p class="form-description">Your review and comments will remain, but this approval will no longer count toward merging.</p>
      <label class="form-label">Reason <span class="review-required">Required</span>
        ${formField({ label: 'Reason', value: draft.value, multiline: true, maxLength: 1000, disabled: draft.saving,
          onInput: value => { draft.value = value; content(); } })}
      </label>
      ${formError(draft.error)}
      ${formActions({ saving: draft.saving, disabled: !draft.value.trim(), submitLabel: 'Revoke approval', pendingLabel: 'Revoking…', onCancel: popover.close, tone: 'danger' })}
    </form>` : html`<div class="popover-menu"><a class="popover-menu-item" href=${githubUrl(reviewer.reviewUrl)} target="_blank" rel="noopener noreferrer">View review <span aria-hidden="true">↗</span></a>
      <button class="popover-menu-item destructive" type="button" @click=${() => { draft.confirm = true; content(); popover.panel.querySelector('textarea').focus(); }}>Revoke approval…</button></div>`, popover.panel);
  }
  return {
    close() { popover.close(); },
    reset() { popover.close(); active = null; },
    recover() { content(); if (active && !popover.isOpen) popover.panel.showPopover(); },
    reconcile(ids) { if (active && !ids.has(active.pr.id) && !changes.get(active.pr.id)?.saving) popover.close(); },
    button(pr, reviewer, avatar) {
      if (active?.pr.id === pr.id) { active = { pr, reviewer }; content(); }
      const busy = [...changes.values()].some(draft => draft.saving);
      return actionButton({ className: 'badge approved review-action', label: 'Your approval options',
        popover: popover.panel, expanded: popover.pullId === pr.id, disabled: busy,
        onClick: event => {
          if (active?.pr.id !== pr.id) {
            if (active) changes.delete(active.pr.id);
            active = { pr, reviewer };
            changes.set(pr.id, { reviewId: reviewer.reviewId, value: '', confirm: false, saving: false, error: '' });
          }
          popover.attach(event.currentTarget); content();
        }, content: avatar ?? html`${reviewStatus('✓', 'approved')}${icon('chevron-down', 12)}` });
    },
  };
}
