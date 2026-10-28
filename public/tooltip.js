import { directive, AsyncDirective, nothing, render } from './vendor/lit-html.js';
import { createPopover } from './popover.js';

// One non-interactive tooltip, shared across rows and positioned like other popovers.
let popup, active, described, timer;
function cancelTimer() { clearTimeout(timer); }
function hide() {
  cancelTimer();
  described?.removeAttribute('aria-describedby');
  described = null; active = null; popup?.close();
}
function scheduleHide() {
  cancelTimer();
  timer = setTimeout(() => {
    if (active?.element.contains(document.activeElement) || active?.element.matches(':hover') || popup?.panel.matches(':hover')) return;
    hide();
  }, 120);
}
function show(owner) {
  cancelTimer();
  if (!owner.element.isConnected) return;
  if (!popup) {
    popup = createPopover({ id: 'row-tooltip', className: 'row-tooltip', role: 'tooltip', mode: 'manual', align: 'end' });
    popup.panel.addEventListener('pointerenter', cancelTimer);
    popup.panel.addEventListener('pointerleave', scheduleHide);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
    window.addEventListener('blur', hide);
  }
  if (active !== owner) hide();
  active = owner;
  described = owner.element.querySelector('a, button, [tabindex]') ?? owner.element;
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
        cancelTimer(); timer = setTimeout(() => show(this), 500);
      });
      this.element.addEventListener('pointerleave', scheduleHide);
      this.element.addEventListener('focusin', () => show(this));
      this.element.addEventListener('focusout', scheduleHide);
      this.element.addEventListener('click', hide);
    }
    if (active === this) { render(content, popup.panel); popup.reposition(); }
    return nothing;
  }
  disconnected() { if (active === this) hide(); }
});
