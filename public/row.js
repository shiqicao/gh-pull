import { iconButton, formError } from './controls.js';
import { html, nothing, repeat } from './vendor/lit-html.js';
import { labels, relativeTime, NAME_COLOR_COUNT, isOwn } from './model.js';
import { iconTemplate as icon, badge, githubUrl, usernameLink, repositoryLink, copyFeedback, reviewStatus } from './templates.js';

const reviewLabels = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required', REVIEW_BYPASS_AVAILABLE: 'Review bypass available' };
const reviewStates = {
  REQUESTED: ['Awaiting review', 'review_required', '◷'], APPROVED: ['Approved', 'approved', '✓'],
  CHANGES_REQUESTED: ['Changes requested', 'changes_requested', '!'], COMMENTED: ['Commented', 'commented', '⋯'], DISMISSED: ['Review dismissed', 'dismissed', '−'],
};
function dependency(node) {
  const pr = node.mergedParent ?? node.externalParent ?? (node.lane > 3 ? node.parent?.pr : null);
  if (pr) {
    const state = pr.status === 'MERGED' ? 'merged' : pr.status === 'CLOSED' ? 'closed' : node.externalParent ? 'not loaded' : '';
    const title = state === 'merged' ? 'Parent PR has already merged; it is no longer an active dependency'
      : state === 'closed' ? 'Parent PR was closed without merging'
      : node.externalParent ? 'Parent PR is outside this group’s loaded open results' : 'Parent PR is beyond the four visible lanes';
    return html`<span class="dependency-chip" title=${title}>↑ #${pr.number}${state ? ` · ${state}` : ''}</span>`;
  }
  return node.unloadedBase ? html`<span class="dependency-chip" title=${`Base branch: ${node.pr.baseBranch}. Its parent PR could not be identified in the loaded results or GitHub lookup.`}>↑ base not loaded</span>` : nothing;
}
function checks(pr) {
  if (pr.checks === 'FAILURE' && githubUrl(pr.url) !== nothing) return html`<a class="badge failure" href=${githubUrl(pr.url, 'checks')}
    target="_blank" rel="noopener noreferrer" data-view-pr title="View checks (opens in a new tab)"
    aria-label=${`Checks failed: view checks for ${pr.title} (opens in a new tab)`}>${labels[pr.checks]}</a>`;
  const pending = pr.checks === 'PENDING' && pr.checkCounts?.total > 0;
  const title = pending ? `${pr.checkCounts.passed} passed of ${pr.checkCounts.total} checks` : nothing;
  return html`<span class=${`badge ${pr.checks.toLowerCase()}`} title=${title} aria-label=${pending ? `Checks pending: ${title}` : nothing}>${labels[pr.checks] ?? pr.checks}${pending ? ` · ${pr.checkCounts.passed}/${pr.checkCounts.total}` : ''}</span>`;
}

export function renderRow(node, gutter, ctx) {
  const { pr } = node;
  const { viewedStore, markViewed, viewerLogin, draftChanges, merges, titleEdits,
    render, focusTitleControl, createMergeAction, issuePopover, titleEditor, reviewControl, lifecycleControl, savingPull, nameColors } = ctx;
  const hasUpdates = viewedStore.hasUpdates(pr), own = isOwn(pr, viewerLogin);
  const url = githubUrl(pr.url), hasUrl = url !== nothing;
  const author = name => usernameLink(name, 'badge author', nameColors[name.toLowerCase()] * 360 / NAME_COLOR_COUNT);
  const onOpen = event => {
    if (((event.type === 'click' && event.button === 0) || (event.type === 'auxclick' && event.button === 1)) && event.target.closest('a[data-view-pr][href]')) markViewed(pr);
  };
  const edit = () => {
    if (!titleEdits.has(pr.id)) titleEdits.set(pr.id, { value: pr.title, expectedTitle: pr.title, saving: false, error: '' });
    render(); focusTitleControl(pr.id, '.title-editor input');
  };
  const filesKnown = Number.isInteger(pr.changedFiles) && pr.changedFiles >= 0;
  const age = relativeTime(pr.updatedAt), diff = `${pr.additions} additions, ${pr.deletions} deletions`;
  const threads = pr.reviewThreadCounts?.total > 0 ? pr.reviewThreadCounts : null;
  const commentTitle = threads ? `${threads.resolved} of ${threads.total} review threads resolved; ${pr.commentCount ?? 0} total comments`
    : `${pr.commentCount} ${pr.commentCount === 1 ? 'comment' : 'comments'}${pr.reviewThreadCounts === null ? '; review thread resolution unavailable' : ''}`;
  return html`${gutter ? html`<div class="dependency-gutter" aria-hidden="true"></div>` : nothing}
    <div class=${`pr-row${hasUpdates ? ' has-updates' : ''}`} data-pr-id=${pr.id} @click=${onOpen} @auxclick=${onOpen}>
      <div class="pr-content"><div class="title-line">
        ${node.parent ? html`<span class="sr-only">Merges into #${node.parent.pr.number}: ${node.parent.pr.title}</span>` : nothing}
        ${own && (['OPEN', 'DRAFT'].includes(pr.status) || pr.canReopen) ? lifecycleControl(pr, Boolean(savingPull(pr.id))) : badge(labels[pr.status], pr.status)}
        ${hasUrl ? html`<span class="pr-links">
          ${iconButton({ icon: 'copy', className: 'copy-link', title: 'Copy PR link', label: `Copy link to ${pr.title}`,
            copy: { text: url, success: 'PR link copied' } })}
          <a class="pr-files icon-button" href=${githubUrl(pr.url, 'files')} target="_blank" rel="noopener noreferrer" data-view-pr
            title="View code changes (opens in a new tab)" aria-label=${`View code changes for ${pr.title}${filesKnown ? `, ${pr.changedFiles} ${pr.changedFiles === 1 ? 'file' : 'files'} changed` : ''} (opens in a new tab)`}>${icon('files')}${filesKnown ? html`<span class="file-count">${pr.changedFiles}</span>` : nothing}</a>
        </span>` : nothing}
        <a class="pr-title" href=${url} target="_blank" rel="noopener noreferrer" data-view-pr aria-label=${`${hasUpdates ? 'New updates: ' : ''}${pr.title} (opens in a new tab)`}>${pr.title}</a>
        ${own ? iconButton({ icon: 'edit', className: 'edit-title', title: 'Edit PR title', label: `Edit title of ${pr.title}`,
          disabled: Boolean(titleEdits.get(pr.id)?.saving || merges.get(pr.id)?.saving), onClick: edit }) : nothing}
        ${createMergeAction(pr, hasUrl ? url : null)}
      </div>
      ${formError(merges.get(pr.id)?.error, 'draft-error')}
      ${formError(draftChanges.get(pr.id)?.error, 'draft-error')}
      ${titleEdits.has(pr.id) && own ? titleEditor(pr) : nothing}
      <div class="meta">
        <span class="badge">${repositoryLink(pr.repo)} #${pr.number}</span>${author(pr.author)}${checks(pr)}${dependency(node)}
        ${pr.branch ? html`<button class="branch-copy" type="button" title=${`Copy branch name: ${pr.branch}`} aria-label=${`Copy branch name: ${pr.branch}`}
          ${copyFeedback(pr.branch, 'Branch name copied', `Copy branch name: ${pr.branch}`)}><span class="branch-name">${pr.branch}</span><span class="branch-copy-symbol" aria-hidden="true"><span class="copy-symbol">${icon('copy', 14)}</span><span class="copy-feedback-symbol" hidden></span></span></button>` : nothing}
        ${pr.review !== 'NONE' ? badge(reviewLabels[pr.review] ?? pr.review, pr.review, pr.review === 'REVIEW_BYPASS_AVAILABLE' ? 'GitHub requires reviews for this branch, but your account can bypass branch protections.' : nothing) : nothing}
        <time class="updated-time" datetime=${pr.updatedAt} title=${`Updated ${new Date(pr.updatedAt).toLocaleString()}`} aria-label=${`Updated ${age}`}>${icon('clock', 14)}${age}</time>
        <span class="diff-counts" title=${diff} aria-label=${diff}><span class="additions success">${pr.additions}</span><span class="deletions failure">${pr.deletions}</span></span>
        ${Number.isInteger(pr.commentCount) && pr.commentCount >= 0 ? html`<span class="comment-count" title=${commentTitle} aria-label=${commentTitle}>${icon('comment', 14)}${threads ? `${threads.resolved}/${threads.total}` : pr.commentCount}</span>` : nothing}
        ${issuePopover.button(pr)}${pr.labels.map(label => badge(label, 'label'))}
      </div><span class="sr-only" role="status"></span></div>
      ${pr.reviewers?.length || pr.reviewersTruncated ? html`<div class="reviewers" role="group" aria-label="Reviewers">
        ${repeat(pr.reviewers ?? [], reviewer => reviewer.name, reviewer => {
          const [description, kind, symbol] = reviewStates[reviewer.state] ?? [reviewer.state, 'none', '·'];
          return html`<span class="reviewer" title=${`${reviewer.name}: ${description}`} aria-label=${`${reviewer.name}: ${description}`}>${author(reviewer.name)}${reviewer.canRevoke ? reviewControl(pr, reviewer) : reviewStatus(symbol, kind)}</span>`;
        })}
        ${pr.reviewersTruncated && hasUrl ? html`<a href=${url} target="_blank" rel="noopener noreferrer" data-view-pr>View all on GitHub</a>` : nothing}
      </div>` : nothing}
    </div>`;
}
