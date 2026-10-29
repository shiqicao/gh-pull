import { directive, AsyncDirective, nothing, render } from './vendor/lit-html.js';
import { createPopover } from './popover.js';

// One non-interactive tooltip, shared across rows and positioned like other popovers.
let popup, active, described, hoverTimer, focusTimer, hideTimer;
function cancelHide() { clearTimeout(hideTimer); }
function cancelTimers() { clearTimeout(hoverTimer); clearTimeout(focusTimer); cancelHide(); }
function showOnHover(owner) {
  clearTimeout(hoverTimer); cancelHide();
  hoverTimer = setTimeout(() => {
    if (owner.element.matches(':hover') && !active?.element.contains(document.activeElement)) show(owner);
  }, 500);
}
function hide() {
  cancelTimers();
  described?.removeAttribute('aria-describedby');
  described = null; active = null; popup?.close();
}
function scheduleHide() {
  clearTimeout(hoverTimer); cancelHide();
  hideTimer = setTimeout(() => {
    if (active?.element.contains(document.activeElement) || active?.element.matches(':hover') || popup?.panel.matches(':hover')) return;
    hide();
  }, 120);
}
function showOnFocus(owner) {
  clearTimeout(hoverTimer); clearTimeout(focusTimer); cancelHide();
  // Native popovers can restore focus during their own show/hide operation.
  focusTimer = setTimeout(() => { if (owner.element.contains(document.activeElement)) show(owner); }, 0);
}
function show(owner) {
  cancelTimers();
  if (!owner.element.isConnected) return;
  if (!popup) {
    popup = createPopover({ id: 'row-tooltip', className: 'row-tooltip', role: 'tooltip', mode: 'manual', align: 'end', maxWidth: 384 });
    popup.panel.addEventListener('pointerenter', cancelHide);
    popup.panel.addEventListener('pointerleave', scheduleHide);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
    window.addEventListener('blur', hide);
  }
  if (active !== owner) hide();
  active = owner;
  described = owner.element.matches('a, button, input, select, textarea, [tabindex]')
    ? owner.element : owner.element.querySelector('a, button, [tabindex]') ?? owner.element;
  described.setAttribute('aria-describedby', popup.panel.id);
  render(owner.content, popup.panel);
  popup.attach(owner.element, { align: owner.align });
  if (!popup.isOpen) popup.panel.showPopover();
  else popup.reposition();
}
export const tooltip = directive(class extends AsyncDirective {
  render() { return nothing; }
  update(part, [content, { align = 'end' } = {}]) {
    this.content = content; this.align = align;
    if (!this.element) {
      this.element = part.element;
      this.element.addEventListener('pointerenter', event => {
        if (event.pointerType === 'touch') return;
        showOnHover(this);
      });
      this.element.addEventListener('pointerleave', scheduleHide);
      this.element.addEventListener('focusin', () => showOnFocus(this));
      this.element.addEventListener('focusout', scheduleHide);
      this.element.addEventListener('click', hide);
    }
    if (active === this) { render(content, popup.panel); popup.reposition(); }
    return nothing;
  }
  disconnected() { if (active === this) hide(); }
});

// Plain-text hints share the same renderer as rich title/reviewer tooltips.
// Delegation covers dynamically added controls without per-element listeners.
let installed = false;
export function installTooltips() {
  if (installed) return;
  installed = true;
  const owners = new WeakMap();
  const find = target => target instanceof Element ? target.closest('[data-tooltip]') : null;
  function owner(element) {
    if (!owners.has(element)) owners.set(element, { element, align: 'end', get content() { return element.dataset.tooltip; } });
    return owners.get(element);
  }
  document.addEventListener('pointerover', event => {
    const element = find(event.target);
    if (!element?.dataset.tooltip || event.pointerType === 'touch' || element.contains(event.relatedTarget)) return;
    showOnHover(owner(element));
  });
  document.addEventListener('pointerout', event => {
    const element = find(event.target);
    if (element && !element.contains(event.relatedTarget)) scheduleHide();
  });
  document.addEventListener('focusin', event => {
    const element = find(event.target);
    if (element?.dataset.tooltip) showOnFocus(owner(element));
  });
  document.addEventListener('focusout', event => { if (find(event.target)) scheduleHide(); });
  document.addEventListener('click', hide);
  new MutationObserver(() => {
    if (!active) return;
    if (!active.element.isConnected) hide();
    else if (owners.has(active.element)) {
      if (!active.content) hide();
      else { render(active.content, popup.panel); popup.reposition(); }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tooltip'] });
}
