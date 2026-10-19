import { element } from './ui.js';

// Native dismissal and focus behavior, shared positioning and trigger state.
export function createPopover({ id, className = '', label, labelledBy, align = 'start', onClose = () => {} }) {
  const panel = element('div', undefined, `anchored-popover ${className}`);
  panel.id = id; panel.popover = 'auto';
  panel.setAttribute('role', 'dialog');
  if (label) panel.setAttribute('aria-label', label);
  if (labelledBy) panel.setAttribute('aria-labelledby', labelledBy);
  document.body.append(panel);
  let trigger;
  const isOpen = () => panel.matches(':popover-open');
  function position() {
    if ((!isOpen() && !panel.classList.contains('measuring')) || !trigger?.isConnected) return;
    const rect = trigger.getBoundingClientRect(), width = panel.offsetWidth, height = panel.offsetHeight;
    const left = align === 'end' ? rect.right - width : rect.left;
    panel.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
    const below = rect.bottom + 6;
    panel.style.top = `${Math.max(8, Math.min(below + height <= innerHeight - 8 ? below : rect.top - height - 6, innerHeight - height - 8))}px`;
  }
  panel.addEventListener('beforetoggle', event => {
    const opening = event.newState === 'open';
    if (opening) {
      panel.classList.add('measuring'); position(); panel.classList.remove('measuring');
      panel.scrollTop = 0;
    }
    trigger?.setAttribute('aria-expanded', String(opening));
  });
  panel.addEventListener('toggle', event => { if (event.newState === 'closed' && !isOpen()) onClose(); });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  const observer = new ResizeObserver(position);
  observer.observe(panel);
  return {
    panel, reposition: position,
    get isOpen() { return isOpen(); },
    get pullId() { return isOpen() ? trigger?.closest('.pr-row')?.dataset.prId : null; },
    attach(button) {
      if (trigger !== button && isOpen()) panel.hidePopover();
      trigger?.setAttribute('aria-expanded', 'false'); trigger = button;
    },
    close() { if (isOpen()) panel.hidePopover(); },
    destroy() {
      observer.disconnect(); window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true); panel.remove();
    },
  };
}
