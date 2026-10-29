import { html, nothing, live } from './vendor/lit-html.js';
import { iconTemplate, copyFeedback } from './templates.js';

export function actionButton({ content, label, title, className = '', disabled = false, onClick,
  popover, expanded, feedback = nothing }) {
  return html`<button type="button" class=${className} aria-label=${label} data-tooltip=${title ?? nothing}
    ?disabled=${disabled} @click=${onClick}
    aria-haspopup=${popover ? 'dialog' : nothing} aria-controls=${popover?.id ?? nothing}
    aria-expanded=${popover ? String(Boolean(expanded)) : nothing} .popoverTargetElement=${popover ?? null}
    ${feedback}>${content}</button>`;
}

export function iconButton({ icon, copy, ...options }) {
  const symbol = iconTemplate(icon);
  return actionButton({ ...options, className: `icon-button ${options.className ?? ''}`,
    content: copy ? html`<span class="copy-symbol">${symbol}</span><span class="copy-feedback-symbol" aria-hidden="true" hidden></span>` : symbol,
    feedback: copy ? copyFeedback(copy.text, copy.success, options.title) : nothing });
}

export function formField({ label, value, onInput, disabled = false, multiline = false, maxLength, required = true }) {
  return multiline
    ? html`<textarea class="form-input" aria-label=${label} .value=${live(value)} ?required=${required}
        maxlength=${maxLength ?? nothing} ?disabled=${disabled} @input=${event => onInput(event.target.value)}></textarea>`
    : html`<input class="form-input" type="text" aria-label=${label} .value=${live(value)} ?required=${required}
        maxlength=${maxLength ?? nothing} ?disabled=${disabled} @input=${event => onInput(event.target.value)}>`;
}

export const formError = (message, className = '') => message
  ? html`<p class=${`error-message ${className}`} role="alert">${message}</p>` : nothing;

export function formActions({ saving, disabled, submitLabel, pendingLabel, onCancel, tone = 'default' }) {
  return html`<div class="form-actions">
    <button type="button" ?disabled=${saving} @click=${onCancel}>Cancel</button>
    <button type="submit" class=${tone === 'danger' ? 'button-danger' : nothing} ?disabled=${saving || disabled}>${saving ? pendingLabel : submitLabel}</button>
  </div>`;
}
