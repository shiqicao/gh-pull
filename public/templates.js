import { html, nothing, guard, directive, AsyncDirective } from './vendor/lit-html.js';
import { icon } from './ui.js';

export const iconTemplate = (name, size = 16) => guard([name, size], () => icon(name, size));
export const badge = (text, kind, title = nothing) => html`<span class=${`badge ${kind.toLowerCase()}`} title=${title}>${text}</span>`;
export function githubUrl(value, suffix = '') {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return nothing;
    if (suffix) { url.pathname = `${url.pathname.replace(/\/$/, '')}/${suffix}`; url.search = ''; url.hash = ''; }
    return url.href;
  } catch { return nothing; }
}
// Use CSSOM even on the first render; styleMap initially writes a style
// attribute, which is still blocked by a strict style-src-attr policy.
const authorHue = directive(class extends AsyncDirective {
  render() { return nothing; }
  update(part, [hue]) {
    if (hue === undefined) part.element.style.removeProperty('--author-hue');
    else part.element.style.setProperty('--author-hue', String(hue));
    return nothing;
  }
});
export function usernameLink(name, className = '', hue) {
  const classes = `${className} username-link`;
  if (name === 'deleted-user' || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(name)) return html`<span class=${classes}>${name}</span>`;
  return html`<a class=${classes} ${authorHue(hue)}
    href=${`https://github.com/${encodeURIComponent(name)}`} target="_blank" rel="noopener noreferrer"
    aria-label=${`${name}'s GitHub profile (opens in a new tab)`}>${name}</a>`;
}
export const repositoryLink = repo => html`<a class="repo-link" href=${`https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}`}
  target="_blank" rel="noopener noreferrer" aria-label=${`${repo} repository (opens in a new tab)`}>${repo}</a>`;

// The listener is installed once per button. Its inputs stay current, and the
// temporary clipboard indicator lives outside Lit's child expression markers.
class ClipboardDirective extends AsyncDirective {
  render() { return nothing; }
  update(part, [text, success, title]) {
    this.title = title;
    if (this.text !== text) this.restore();
    this.text = text; this.success = success;
    if (!this.button) {
      this.button = part.element;
      this.click = async () => {
        this.restore();
        const revision = this.revision;
        const symbol = this.button.querySelector('.copy-symbol');
        const feedback = this.button.closest('.pr-row').querySelector('[role="status"]');
        const indicator = this.button.querySelector('.copy-feedback-symbol');
        this.reset = () => { symbol.hidden = false; indicator.hidden = true; indicator.textContent = ''; this.button.title = this.title; feedback.textContent = ''; };
        let copied = true;
        try { await navigator.clipboard.writeText(this.text); } catch { copied = false; }
        if (revision !== this.revision) return;
        symbol.hidden = true; indicator.hidden = false;
        indicator.textContent = copied ? '✓' : '!';
        this.button.title = copied ? this.success : 'Could not copy. Allow clipboard access and retry.';
        if (!this.isConnected) { this.restore(); return; }
        feedback.textContent = this.button.title;
        this.timer = setTimeout(() => this.restore(), 2000);
      };
      this.button.addEventListener('click', this.click);
    }
    return nothing;
  }
  restore() { this.revision = (this.revision ?? 0) + 1; clearTimeout(this.timer); this.reset?.(); this.reset = null; }
  disconnected() { this.restore(); }
}
export const copyFeedback = directive(ClipboardDirective);

export const reviewStatus = (symbol, kind) => html`<span class=${`badge ${kind} review-status`} aria-hidden="true">${symbol}</span>`;
