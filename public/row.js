import { tooltip } from './tooltip.js';
import { iconButton, formError } from './controls.js';
import { html, nothing, repeat } from './vendor/lit-html.js';
import { labels, reviewLabels, reviewStates, relativeTime, NAME_COLOR_COUNT, isOwn } from './model.js';
import { iconTemplate as icon, badge, githubUrl, usernameLink, repositoryLink, ageTint, copyFeedback, reviewerAvatar, authorHue } from './templates.js';

function dependency(node) {
  const pr = node.mergedParent ?? node.externalParent ?? (node.lane > 3 ? node.parent?.pr : null);
  if (pr) {
    const state = pr.status === 'MERGED' ? 'merged' : pr.status === 'CLOSED' ? 'closed' : node.externalParent ? 'not loaded' : '';
    const title = state === 'merged' ? 'Parent PR has already merged; it is no longer an active dependency'
      : state === 'closed' ? 'Parent PR was closed without merging'
      : node.externalParent ? 'Parent PR is outside this group’s loaded open results' : 'Parent PR is beyond the four visible lanes';
    return html`<span class="dependency-chip" aria-description=${title} data-tooltip=${title}>↑ #${pr.number}${state ? ` · ${state}` : ''}</span>`;
  }
  const baseDescription = `Base branch: ${node.pr.baseBranch}. Its parent PR could not be identified in the loaded results or GitHub lookup.`;
  return node.unloadedBase ? html`<span class="dependency-chip" aria-description=${baseDescription} data-tooltip=${baseDescription}>↑ base not loaded</span>` : nothing;
}
function checks(pr) {
  const pending = pr.checks === 'PENDING' && pr.checkCounts?.total > 0;
  const label = `${labels[pr.checks] ?? pr.checks}${pending ? ` · ${pr.checkCounts.passed}/${pr.checkCounts.total}` : ''}`;
  const symbol = { SUCCESS: 'check', FAILURE: 'cross', PENDING: 'clock' }[pr.checks] ?? 'dash';
  const content = html`${icon(symbol, 16)}<span class="sr-only">${label}</span>`;
  return githubUrl(pr.url) !== nothing
    ? html`<a class=${`ci-indicator ${pr.checks.toLowerCase()}`} href=${githubUrl(pr.url, 'checks')} target="_blank" rel="noopener noreferrer" data-view-pr data-tooltip=${`${label} · View checks (opens in a new tab)`} aria-label=${`${label}: view checks for ${pr.title} (opens in a new tab)`}>${content}</a>`
    : html`<span class=${`ci-indicator ${pr.checks.toLowerCase()}`} data-tooltip=${label} aria-label=${label}>${content}</span>`;
}

function metadata(pr, ctx) {
  const age = relativeTime(pr.updatedAt), diff = `${pr.additions} additions, ${pr.deletions} deletions`;
  const threads = pr.reviewThreadCounts?.total > 0 ? pr.reviewThreadCounts : null;
  const commentTitle = threads ? `${threads.resolved} of ${threads.total} review threads resolved; ${pr.commentCount ?? 0} total comments`
    : `${pr.commentCount ?? 0} total comments${pr.reviewThreadCounts === null ? '; review thread resolution unavailable' : ''}`;
  return html`<div class="meta">
    <span class="pr-ci">${checks(pr)}</span>
    <span class="pr-review">${pr.review !== 'NONE' ? badge(reviewLabels[pr.review] ?? pr.review, pr.review, pr.review === 'REVIEW_BYPASS_AVAILABLE' ? 'GitHub requires reviews for this branch, but your account can bypass branch protections.' : reviewLabels[pr.review]) : html`<span class="empty-value" aria-label="No review status">—</span>`}</span>
    <span class="diff-counts" data-tooltip=${diff} aria-label=${diff}><span class="additions">+${pr.additions}</span><span class="deletions">−${pr.deletions}</span></span>
    ${ctx.commentControl(pr, threads ? `${threads.resolved}/${threads.total}` : Number.isInteger(pr.commentCount) && pr.commentCount > 0 ? html`${icon('comment', 12)}${pr.commentCount}` : html`${icon('comment', 12)}0`, commentTitle, Boolean(ctx.savingPull(pr.id)))}
    <time class="updated-time" ${ageTint(pr.updatedAt)} datetime=${pr.updatedAt} data-tooltip=${`Updated ${new Date(pr.updatedAt).toLocaleString()}`} aria-label=${`Updated ${age}`}><span class="age-content">${age === 'just now' ? 'now' : age.replace(/ ago$/, '')}</span></time>
  </div>`;
}

function reviewerList(pr, ctx) {
  const { nameColors, reviewControl, reviewerManager, savingPull, viewerLogin } = ctx;
  const order = { CHANGES_REQUESTED: 0, REQUESTED: 1, COMMENTED: 2, DISMISSED: 3, APPROVED: 4 };
  const sorted = [...(pr.reviewers ?? [])].sort((a, b) => (order[a.state] ?? 5) - (order[b.state] ?? 5) || a.name.localeCompare(b.name));
  const manage = isOwn(pr, viewerLogin) && ['OPEN', 'DRAFT'].includes(pr.status) && reviewerManager;
  const hasReviewers = sorted.length > 0 || pr.reviewersTruncated || manage;
  return html`<div class="reviewers" role=${hasReviewers ? 'group' : nothing} aria-label=${hasReviewers ? 'Reviewers' : nothing}>
    <div class="reviewer-avatars">${repeat(sorted, r => r.name, reviewer => {
      const description = reviewStates[reviewer.state]?.[0] ?? reviewer.state;
      const avatar = reviewerAvatar(reviewer.name, reviewer.state, nameColors[reviewer.name.toLowerCase()] * 360 / NAME_COLOR_COUNT, reviewer.kind, !reviewer.canRevoke);
      return html`<span class="reviewer" aria-label=${`${reviewer.name}: ${description}`} ${tooltip(html`<strong class="reviewer-tooltip-name group-author" ${authorHue(nameColors[reviewer.name.toLowerCase()] * 360 / NAME_COLOR_COUNT)}>${reviewer.name}</strong><span class=${`reviewer-tooltip-status reviewer-${reviewer.state.toLowerCase()}`}><i aria-hidden="true"></i>${description}</span>${reviewer.canRevoke ? html`<span class="reviewer-tooltip-hint" aria-hidden="true">Click for approval options</span>` : nothing}`)}>${reviewer.canRevoke ? reviewControl(pr, reviewer, avatar) : avatar}</span>`;
    })}</div>
    ${pr.reviewersTruncated && githubUrl(pr.url) !== nothing ? html`<a class="reviewers-more" href=${githubUrl(pr.url)} target="_blank" rel="noopener noreferrer" data-view-pr data-tooltip="View all reviewers on GitHub" aria-label="View all reviewers on GitHub">All ↗</a>` : nothing}
    ${manage ? reviewerManager(pr, Boolean(savingPull(pr.id))) : nothing}
  </div>`;
}

export function renderRow(node, gutter, ctx) {
  const { pr } = node;
  const { viewedStore, markViewed, viewerLogin, draftChanges, merges, titleEdits,
    render, focusTitleControl, createMergeAction, issuePopover, titleEditor, lifecycleControl, nameColors } = ctx;
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
  return html`${gutter ? html`<div class="dependency-gutter" aria-hidden="true"></div>` : nothing}
    <div class=${`pr-row${hasUpdates ? ' has-updates' : ''}`} data-pr-id=${pr.id} @click=${onOpen} @auxclick=${onOpen}>
      <div class="pr-content"><div class="title-line">
        ${node.parent ? html`<span class="sr-only">Merges into #${node.parent.pr.number}: ${node.parent.pr.title}</span>` : nothing}
        ${own && (['OPEN', 'DRAFT'].includes(pr.status) || pr.canReopen) ? lifecycleControl(pr, Boolean(ctx.savingPull(pr.id))) : badge(labels[pr.status], pr.status)}
        <div class="pr-identity">
          <a class="pr-reference" href=${url} target="_blank" rel="noopener noreferrer" data-view-pr data-tooltip=${`${pr.repo} #${pr.number}`} aria-label=${`${pr.repo} #${pr.number} (opens in a new tab)`}><span>${pr.repo.split('/').pop()}</span><span class="pr-number">#${pr.number}</span></a>
          ${hasUrl ? iconButton({ icon: 'copy', className: 'copy-link', title: 'Copy PR link', label: `Copy link to ${pr.title}`, copy: { text: url, success: 'PR link copied' } }) : nothing}
        </div>
        <div class="pr-title-cell">
          <div class="pr-title-heading"><a class="pr-title" href=${url} target="_blank" rel="noopener noreferrer" data-view-pr ${tooltip(html`<span class="title-tooltip-text">${pr.title}</span>`, { align: 'start' })} aria-label=${`${hasUpdates ? 'New updates: ' : ''}${pr.title} (opens in a new tab)`}>${pr.title}</a>
            ${own ? iconButton({ icon: 'edit', className: 'edit-title', title: 'Edit PR title', label: `Edit title of ${pr.title}`, disabled: Boolean(titleEdits.get(pr.id)?.saving || merges.get(pr.id)?.saving), onClick: edit }) : nothing}
          </div>
          <div class="pr-branch-line">
            ${pr.branch ? html`<button class="branch-copy" type="button" data-tooltip=${`Copy branch name: ${pr.branch}`} aria-label=${`Copy branch name: ${pr.branch}`}
              ${copyFeedback(pr.branch, 'Branch name copied', `Copy branch name: ${pr.branch}`)}><span class="branch-name">${pr.branch}</span><span class="branch-copy-symbol" aria-hidden="true"><span class="copy-symbol">${icon('copy', 12)}</span><span class="copy-feedback-symbol" hidden></span></span></button>` : nothing}
            ${hasUrl ? html`<a class="pr-files" href=${githubUrl(pr.url, 'files')} target="_blank" rel="noopener noreferrer" data-view-pr data-tooltip="View code changes (opens in a new tab)" aria-label=${`View code changes for ${pr.title}${filesKnown ? `, ${pr.changedFiles} ${pr.changedFiles === 1 ? 'file' : 'files'} changed` : ''} (opens in a new tab)`}>${filesKnown ? html`<span class="file-count">${pr.changedFiles}</span> ${pr.changedFiles === 1 ? 'file' : 'files'}` : 'files'}</a>` : nothing}
          </div>
          ${ctx.groupBy !== 'author' ? html`<div class="pr-author">${author(pr.author)}</div>` : nothing}
          <div class="pr-extras">${dependency(node)}${createMergeAction(pr, hasUrl ? url : null)}${issuePopover.button(pr)}${pr.labels.map(label => badge(label, 'label'))}</div>
        </div>
      </div>
      ${metadata(pr, ctx)}
      ${formError(merges.get(pr.id)?.error, 'draft-error')}${formError(draftChanges.get(pr.id)?.error, 'draft-error')}
      ${titleEdits.has(pr.id) && own ? titleEditor(pr) : nothing}<span class="sr-only" role="status"></span></div>
      ${reviewerList(pr, ctx)}
    </div>`;
}
