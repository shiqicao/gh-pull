import { createPopover } from './popover.js';
import { html, render, nothing, repeat } from './vendor/lit-html.js';
import { githubUrl, iconTemplate as icon } from './templates.js';

// One native popover is shared by all rows: outside click, Escape, and keyboard
// focus restoration are handled by the browser, without per-row global listeners.
export function createIssuePopover({ onClose = () => {} } = {}) {
  const popover = createPopover({ id: 'closing-issues', className: 'issue-popover', labelledBy: 'closing-issues-title', onClose });
  const { panel } = popover;
  return {
    reposition: popover.reposition,
    get isOpen() { return popover.isOpen; },
    get pullId() { return popover.pullId; },
    close: popover.close,
    button(pr) {
      const count = pr.closingIssueCount ?? pr.closingIssues?.length ?? 0;
      const content = () => {
        render(html`<h2 id="closing-issues-title">Closing issues (${count})</h2><ul class="issue-list">
          ${repeat(pr.closingIssues ?? [], issue => `${issue.repo}#${issue.number}`, issue => {
            const closed = issue.state === 'CLOSED';
            return html`<li><span class=${`issue-symbol ${closed ? 'issue-closed' : 'issue-open'}`}>${icon(closed ? 'issue-closed' : 'issue')}</span>
              <a class="issue-link" href=${githubUrl(issue.url)} target="_blank" rel="noopener noreferrer"
                aria-label=${`${issue.title} · ${closed ? 'Closed' : 'Open'} · ${issue.repo} #${issue.number} (opens in a new tab)`}>
                <span class="issue-title">${issue.title}</span><span class="issue-detail">${closed ? 'Closed' : 'Open'} · ${issue.repo} #${issue.number}</span></a></li>`;
          })}</ul>${pr.closingIssuesTruncated || count > (pr.closingIssues?.length ?? 0) ? html`<a class="issue-more" href=${githubUrl(pr.url)} target="_blank" rel="noopener noreferrer">View all linked issues on GitHub ↗</a>` : nothing}`, panel);
      };
      if (popover.pullId === pr.id) { content(); }
      if (!count) return nothing;
      const title = `Closes ${count} ${count === 1 ? 'issue' : 'issues'}`;
      return html`<button class="issue-count" type="button" title=${title} aria-label=${`${title} · ${pr.repo} #${pr.number}`}
        aria-haspopup="dialog" aria-controls=${panel.id} .popoverTargetElement=${panel}
        @click=${event => {
          popover.attach(event.currentTarget);
          content();
        }} aria-expanded=${String(popover.pullId === pr.id)}>${icon('issue', 14)}${count}</button>`;
    },
  };
}
