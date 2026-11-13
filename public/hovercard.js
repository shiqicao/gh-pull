import { directive, AsyncDirective, nothing, render } from './vendor/lit-html.js';
import { createPopover } from './popover.js';

if (!('interestForElement' in HTMLButtonElement.prototype)) await import('./vendor/interestfor.js');

let nextId = 0;
// A rich hint has real links. Keep it next to its invoker in the DOM for
// reading and Tab order, without moving focus when interest opens it.
export const hovercard = directive(class extends AsyncDirective {
  render() { return nothing; }
  update(part, [content]) {
    this.element = part.element;
    if (!this.popup) {
      this.popup = createPopover({ id: `ci-hovercard-${++nextId}`, className: 'row-tooltip ci-hovercard',
        role: 'group', label: 'Failed checks', mode: 'hint', align: 'end', maxWidth: 384, manageExpanded: false });
      this.popup.attach(this.element);
      this.element.after(this.popup.panel);
      // Explicitly return from the first item: interest invokers can otherwise
      // revisit the popover's last link when traversing backward.
      this.popup.panel.addEventListener('keydown', event => {
        if (event.key === 'Tab' && event.shiftKey && event.target === this.popup.panel.querySelector('a')) {
          event.preventDefault();
          this.element.focus();
        }
      });
      this.element.setAttribute('interestfor', this.popup.panel.id);
      this.element.setAttribute('aria-details', this.popup.panel.id);
    }
    render(content, this.popup.panel);
    this.popup.reposition();
    return nothing;
  }
  disconnected() {
    this.element.removeAttribute('interestfor');
    this.element.removeAttribute('aria-details');
    this.popup?.destroy();
    this.popup = null;
  }
});
