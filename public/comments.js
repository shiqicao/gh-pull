import { html, render, repeat, nothing } from './vendor/lit-html.js';
import { actionButton, formField, formError, formActions } from './controls.js';
import { githubUrl } from './templates.js';
import { hasPreset, insertPreset } from './preset-model.js';
import { presets, openSettings } from './quick-presets.js';
import { matchesQuickComment } from './quick-comment-scope.js';
import { createPopover } from './popover.js';

export function createCommentControls({ changes, submit, onClose }) {
  let active, more=false, filter='', note='';
  const narrow=matchMedia('(max-width: 37.5em)'); narrow.addEventListener('change',()=>content());
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
    const all=presets.filter(p=>matchesQuickComment(p,pr.repo)), limit=narrow.matches?3:5;
    const shown=all.length>limit+1?all.slice(0,limit):all, rest=all.slice(shown.length);
    const results=(filter.trim()?all:rest).filter(p=>(p.label+' '+p.body).toLowerCase().includes(filter.trim().toLowerCase()));
    const pick=p=>{if(draft.saving)return;const next=insertPreset(draft.value,p.body);note=next===draft.value?`“${p.label}” is already in the draft. Nothing added.`:next.length>4000?'This preset would exceed the comment length limit.':`Inserted “${p.label}”. Review it, then post.`;if(next.length<=4000)draft.value=next;more=false;filter='';content();const t=popover.panel.querySelector('textarea');t.focus();t.setSelectionRange(t.value.length,t.value.length);};
    const toggle=()=>{more=!more;filter='';content();popover.panel.querySelector(more?'.preset-filter':'.preset-more')?.focus();};
    const manage=(create=false)=>{
      const snapshot=JSON.stringify(presets);popover.close();openSettings(create,pr,()=>{
        const trigger=document.querySelector(`.pr-row[data-pr-id="${CSS.escape(pr.id)}"] .comment-count`);
        if(!trigger){document.getElementById('settings').focus();return;}
        trigger.click();note=(snapshot===JSON.stringify(presets)?'':'Presets updated. ')+'Your draft is as you left it.';content();popover.panel.querySelector('textarea')?.focus();
      });
    };
    render(html`<form @submit=${event => {
      event.preventDefault();
      if (!draft.saving && draft.value.trim()) void submit(pr, draft);
    }} @keydown=${event => {
      if(event.key==='Escape' && more){event.preventDefault();event.stopPropagation();toggle();return;}
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.requestSubmit(); }
    }}>
      <div class="qc-header"><h2>Quick comment</h2><span title=${pr.repo}>${pr.repo.split('/').at(-1)} #${pr.number}</span><button type="button" class="preset-close" aria-label="Close quick comment" @click=${()=>popover.close()}>×</button></div>
      ${document.getElementById('settings').hidden?nothing:html`<div class="preset-picker" role="group" aria-label="Presets"><div class="preset-caption">Presets <button type="button" @click=${()=>manage()}>Manage</button></div>${shown.length?html`<div class="preset-chips">${repeat(shown,p=>p.id,p=>html`<button type="button" ?disabled=${draft.saving} class=${hasPreset(draft.value,p.body)?'in-draft':''} aria-label=${p.label+(hasPreset(draft.value,p.body)?', already in draft':', inserts '+p.body)} title=${'Inserts: '+p.body} @click=${()=>pick(p)}>${hasPreset(draft.value,p.body)?html`<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"></path></svg>`:nothing}${p.label}</button>`)}${rest.length?html`<button class="preset-more" type="button" aria-expanded=${more} @click=${toggle}>More (${rest.length}) ▾</button>`:nothing}</div>`:html`<p class="preset-hint">${presets.length?`None of your ${presets.length} presets apply to ${pr.repo}.`:'No presets yet. Save comments you post often, like [docker-build], and they appear here.'} <button type="button" @click=${()=>manage(!presets.length)}>${presets.length?'Edit scopes':'Create a preset'}</button></p>`}${more&&rest.length?html`<div class="preset-overflow"><label>All presets for ${pr.repo}<input class="preset-filter" placeholder="Filter by label or text" .value=${filter} @input=${e=>{filter=e.target.value;content();}} @keydown=${e=>{if(e.key==='Enter'){e.preventDefault();if(results[0])pick(results[0]);}}}></label>${repeat(results,p=>p.id,p=>html`<button type="button" @click=${()=>pick(p)}>${p.label} · <code>${p.body}</code></button>`)}${results.length?nothing:`No presets match “${filter}”.`}</div>`:nothing}</div>`}
      <div class="qc-compose"><label>Comment · Markdown
      ${formField({ label: 'Comment', rows:5, placeholder:'Leave a comment', value: draft.value, multiline: true, maxLength: 4000, disabled: draft.saving,
        onInput(value) { draft.value = value; note=''; content(); } })}
      </label><div class="preset-note" data-inserted=${note.startsWith('Inserted')} role="status">${note}</div>${formError(draft.error)}</div>
      <div class="qc-footer"><a href=${githubUrl(pr.url)} target="_blank" rel="noopener noreferrer">View conversation</a><span>Ctrl/⌘+Enter to post</span>
      ${formActions({ saving: draft.saving, disabled: !draft.value.trim(), submitLabel: 'Post comment', pendingLabel: 'Posting…', onCancel() {
        if (!draft.saving) changes.delete(pr.id);
        popover.close();
      } })}
      </div>
    </form>`, popover.panel);
  }
  return {
    reset() { active = null; popover.close(); },
    recover() { content(); if (active && !popover.isOpen) popover.panel.showPopover(); },
    reconcile(ids) { if (active && !ids.has(active.id) && !changes.get(active.id)?.saving) popover.close(); },
    button(pr, count, description, busy) {
      if (active?.id === pr.id) { active = pr; content(); }
      const hasDraft = Boolean(changes.get(pr.id)?.value.trim());
      const action = hasDraft ? 'Continue draft comment' : 'Add a comment';
      return actionButton({ className: 'comment-count', content: html`${count}${hasDraft ? html`<span class="comment-draft-dot" aria-hidden="true"></span>` : nothing}`, title: `${action} · ${description}`, label: `Quick comment on ${pr.title}. ${action}. ${description}`,
        popover: popover.panel, expanded: popover.pullId === pr.id, disabled: busy || [...changes.values()].some(draft => draft.saving),
        onClick(event) {
          if (active && active.id !== pr.id) {
            const previous = changes.get(active.id); if (previous) previous.editing = false;
          }
          active = pr; more=false; filter=''; note='';
          const draft = changes.get(pr.id) ?? { value: '', saving: false, error: '' };
          draft.editing = true; changes.set(pr.id, draft);
          popover.attach(event.currentTarget); content();
          requestAnimationFrame(() => { if (popover.isOpen) popover.panel.querySelector('textarea')?.focus(); });
        },
      });
    },
  };
}
