import { html, render } from './vendor/lit-html.js';
import { actionButton, formField, formError, formActions } from './controls.js';
import { githubUrl } from './templates.js';
import { createPopover } from './popover.js';

export function createCommentControls({ changes, submit, onClose }) {
  let active;
  const popover = createPopover({ id: 'quick-comment', className: 'comment-popover', label: 'Quick comment', align: 'end',
    onClose() {
      if (!active) return;
      const id = active.id, draft = changes.get(id);
      if (draft) draft.editing = false;
      active = null; onClose(id);
    },
  });
  function content() {
    const pr = active, draft = pr && changes.get(pr.id);
    if (!draft) return;
    render(html`<form @submit=${event => {
      event.preventDefault();
      if (!draft.saving && draft.value.trim()) void submit(pr, draft);
    }} @keydown=${event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.requestSubmit(); }
    }}>
      <h2>Quick comment</h2>
      <p class="form-description">${pr.repo} #${pr.number} · PR conversation</p>
      ${formField({ label: 'Comment', value: draft.value, multiline: true, maxLength: 4000, disabled: draft.saving,
        onInput(value) { draft.value = value; content(); } })}
      <p class="comment-help">Markdown supported · Ctrl/⌘+Enter to post</p>
      ${formError(draft.error)}
      <a class="comment-conversation" href=${githubUrl(pr.url)} target="_blank" rel="noopener noreferrer">View conversation ↗</a>
      ${formActions({ saving: draft.saving, disabled: !draft.value.trim(), submitLabel: 'Post comment', pendingLabel: 'Posting…', onCancel() {
        if (!draft.saving) changes.delete(pr.id);
        popover.close();
      } })}
    </form>`, popover.panel);
  }
  return {
    reset() { active = null; popover.close(); },
    recover() { content(); if (active && !popover.isOpen) popover.panel.showPopover(); },
    reconcile(ids) { if (active && !ids.has(active.id) && !changes.get(active.id)?.saving) popover.close(); },
    button(pr, count, description, busy) {
      if (active?.id === pr.id) { active = pr; content(); }
      return actionButton({ className: 'comment-count', content: count, title: `${description} · Add a comment`, label: `Quick comment on ${pr.title}. ${description}`,
        popover: popover.panel, expanded: popover.pullId === pr.id, disabled: busy || [...changes.values()].some(draft => draft.saving),
        onClick(event) {
          if (active && active.id !== pr.id) {
            const previous = changes.get(active.id); if (previous) previous.editing = false;
          }
          active = pr;
          const draft = changes.get(pr.id) ?? { value: '', saving: false, error: '' };
          draft.editing = true; changes.set(pr.id, draft);
          popover.attach(event.currentTarget); content();
          requestAnimationFrame(() => { if (popover.isOpen) popover.panel.querySelector('textarea')?.focus(); });
        },
      });
    },
  };
}
