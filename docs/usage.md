# Using gh-pull

[← Back to the README](../README.md)

## At a glance

- **Query search:** Search GitHub with highlighted qualifiers and autocomplete. Show, State, and Sort are synchronized shortcuts for the query; queries and grouping are shareable through the URL.
- **PR dependencies:** A fixed graph gutter shows branch-based stacks without indenting rows. First children continue their parent’s lane; side branches occupy up to four lanes. Nodes reflect readiness and check status. Trees sort as a unit using their most recently updated member; children appear depth-first in PR-number order. Known open parents outside the loaded group get a dashed stub and “not loaded” chip. Non-default base branches without an identifiable parent PR retain a lane marker and dashed stub labeled “base not loaded.” Closed parents say “closed”; merged parents say “merged” without an active connector. Parent state is checked on GitHub with a one-minute cache; edges beyond four lanes use parent chips. Standalone-only groups have no gutter.
- **Grouping:** Group results by repository, author, status, or checks; collapse groups while preserving GitHub's query order within each group.
- **PR details:** Fixed desktop columns for state, PR, title/branch, CI, review, diff, threads, update time, and reviewers, with a compact layout on narrow screens. Reviewer initials use status rings; bots and teams use square avatars. Hover for full names. Authors, reviewers, review decisions, labels, changed-line and file counts, comment counts, source branches, and update times. Authors and reviewers have consistent colors saved in this browser.
- **Check progress:** Pending badges show passed/total counts, such as **Checks pending · 1/8**. Only successful checks count as passed; skipped and neutral checks do not. Hover or focus a failed-check badge to see failing jobs and open their logs directly. Up to five job names are shown, with a link to more checks when needed. The badge itself opens the PR’s checks page.
- **Closing issues:** A compact issue-count button opens linked issue titles, repository names, and open/closed states. Issue links open in a new tab; PRs without closing issues show no button.
- **Background refresh:** Refreshes the list every 30 seconds and polls PRs with running checks every 15 seconds. Polling pauses while the tab is hidden or offline and while you edit a PR; returning to a stale dashboard refreshes it immediately. Errors trigger automatic backoff, respecting GitHub rate-limit cooldowns. The circular refresh icon shows the countdown in its center and tooltip, and spins while fetching, with the button disabled until the request finishes. Existing PRs stay visible until fresh data arrives, including when a refresh fails.
- **Viewed tracking:** New updates have brighter, bolder titles. Opening a PR, diff, or checks link marks the displayed update as viewed. Newer updates highlight it again; tracking is per GitHub account and synchronized across dashboard tabs.
- **Quick links and copying:** Open PRs, repositories, diffs, and user profiles in new tabs. Usernames keep their existing appearance and show a pointer cursor. Copy PR URLs or branch names with confirmation feedback.
- **Feedback:** Use **report an issue** in the footer to open this repository's GitHub issue form.
- **Appearance:** Inter typography, responsive layout, keyboard-accessible controls, and system light/dark colors.

## Query search

**Review status** sorting (`sort:review-status`) orders loaded PRs by changes requested, review required, approved, then no review, with recently updated PRs first within each category. Dependency stacks stay together and are ordered by their root PR’s review status. This dashboard-specific sort is saved with the query; GitHub fetches pages by recent update.

The default query is `is:open involves:@me sort:updated-desc`. The server always adds `is:pr`; type qualifiers cannot be specified in the editor. Add qualifiers such as `repo:owner/repository`, `author:octocat`, `-label:wip`, or `label:"good first issue"`, and press **Enter** or **Search**. Free text follows GitHub's search semantics (title, body, and comments by default); it no longer filters just the loaded rows.

Type a qualifier or press **Ctrl+Space** for suggestions. Use arrow keys to choose, Enter or Tab to accept, and Escape to dismiss. When a suggestion is selected, Enter accepts it; press Enter again to search. Repository suggestions are fetched from GitHub using the query's people filters (`involves:`, `author:`, `review-requested:`, and similar qualifiers), independently of `repo:` and state filters. With no people filter or no matching repositories, discovery falls back to your account. Loaded repositories appear immediately; fetched repositories are added as they arrive. Results are cached for five minutes and marked as partial when the lookup reaches its page cap or GitHub's 1,000-PR search limit. User, branch, and label suggestions still come from loaded PRs, and you can type values that aren't suggested.

Changing Show, State, or Sort rewrites that part of the query and searches immediately. A dropdown shows **Custom** when the query doesn't match one of its presets. Show replaces author/involvement/review-request qualifiers; State replaces state/draft qualifiers; unrelated terms stay intact. Closed means closed and unmerged. Group by only changes presentation.

Unsubmitted edits stay in the editor while automatic refresh and pagination use the last applied query. Only applied queries are saved in the URL. Reopening the dashboard restores the last applied query and grouping from this browser’s storage; explicit query/filter links take priority. Group headings also remember their expanded/collapsed state per GitHub account and grouping type in browser storage, across queries, tab closure, and dashboard launches. Open tabs at the same dashboard address also synchronize group changes. New groups start expanded. The selected saved view is also remembered per account, including its edited state when the restored query or grouping differs; only Save changes updates the saved view. This selection is specific to the browser and dashboard address (including port), and does not update a saved view. Qualifiers, exclusions, and quoted phrases are supported; Boolean operators and parenthesized groups are not yet supported. Saved views appear as pills above the query in one bordered search panel, with save actions below the filters. Pills size to their names and stay on one row; extra views appear under **More (n)**, with the selected view always visible. Selecting one restores its query and **Group by** setting. On dashboard open, the two most-used views get priority; remaining views rank by usage plus temporary boosts for creation (7-day half-life), saved query/grouping edits (3 days), and recent selection (2 days). Order stays stable during the session, with the selected view kept visible as space allows; narrow windows may fit fewer favorites. Counts and timestamps persist locally across sessions. Opening a view menu or refreshing the dashboard does not count as a selection. **Save changes** explicitly updates the selected view; **Save as new view** creates a named view. Both buttons stay in place and are disabled while query text is unapplied: press Search/Enter first. Search never overwrites a saved view, and Save never runs a search. Changing Group by takes effect immediately but is only persisted to a view when you save. Edited views show a dot and a status message with **Revert**; switching away offers **Undo**. Clicking the selected pill’s **▾** opens rename and delete, with Undo after deletion. Failed saves keep edits and offer Retry. Ctrl/⌘+S saves applied changes (or opens the name prompt when no view is selected). Views are stored per GitHub account in `$XDG_CONFIG_HOME/gh-pull/saved-views.json` (default: `~/.config/gh-pull/saved-views.json`) and survive browser cache clearing and extension upgrades. They stay on this machine and do not sync across devices.

## Predefined quick comments

Use **Settings → Quick comments** to give a reusable comment a label and body. For example, a preset labeled **Build image** could insert `[docker-build]` into the comment draft. Review the draft and choose **Post comment** when ready.

Each GitHub account has a `presets` array next to its saved `views` in the JSON config selected by `--config`. Its order is the chip order. Example array entry:

```json
{
  "id": "build-image",
  "label": "Build image",
  "body": "[docker-build]",
  "repos": ["maple-labs/seedling"],
  "orgs": ["fern-workshop"]
}
```

This preset applies to `maple-labs/seedling` **or** any repository owned by `fern-workshop`. Names match exactly, ignoring case. Omit both lists to make a preset available everywhere. Once either list is present, only explicit matches count: `"repos": []` by itself shows the preset nowhere; adding a matching org still enables it there.

## PR actions

Actions apply to your own PRs and require GitHub write permissions:

- **Edit a title:** Select the pencil icon. Save or Enter submits; Cancel or Escape discards. Titles must be 1–256 characters on one line. Failed saves retain the draft, and the server checks whether the title changed on GitHub before updating it.
- **Manage reviewers:** On your open PRs, select the **Manage reviewers** people icon in the Reviewers column. Browse repository contributors (up to 100, cached for five minutes), search GitHub suggestions, or enter an exact username or `org/team`, request or re-request a review, or remove a pending request. Selections stay pending until you select **Apply changes**; closing the popup discards unapplied selections. Removing a request preserves past reviews and comments. Draft PRs must be marked ready first; GitHub enforces reviewer eligibility and token permissions.
- **Change draft status:** Select **Open** to convert a PR to draft, or **Draft** to mark it ready for review. A tooltip explains the action on hover. The badge changes after GitHub confirms, and merge readiness is rechecked automatically.
- **Merge:** Eligible PRs default to your preferred GitHub merge method. When the repository allows multiple methods, a dropdown offers merge commit, squash, or rebase using GitHub's current settings. A valid selection survives refreshes; disabled methods are removed. The server rechecks the chosen method, permissions, and readiness and pins the merge to the displayed commit. Drafts, blocked PRs, merge queues, and stacked PRs do not show this action.

If GitHub is still calculating mergeability, the dashboard rechecks in the background every two seconds, up to five times, without resetting loaded pages. Adaptive background polling continues afterward.

## Threads and quick comments

The **Threads** cell shows a comment bubble beside the **total review-thread count**, with an amber notification badge for **unresolved threads**. Unresolved threads started by the PR author with no replies are excluded from the badge, but remain in the total. Once a thread has a reply, it counts as unresolved until resolved. The badge disappears when no counted unresolved threads remain. Hover for an explanation and the total PR comment count, which includes conversation comments and replies. PRs render immediately while thread counts load separately in the background, refreshing at most once a minute per PR version. PRs with no review threads show a muted dash. Loading, failed, or incomplete lookups (including more than 1,000 threads) also show a dash, with the tooltip distinguishing unavailable counts from zero threads.

Click a PR’s **Threads** cell to write a quick Markdown comment on its conversation. **Post comment** (or Ctrl/⌘+Enter) submits it; Escape or clicking outside keeps the draft for this session, and Cancel discards it. Comments are limited to 4,000 characters. Posting a conversation comment does not change review-thread counts.

## Close and reopen

On your own PRs, the Open/Draft badge menu includes **Close pull request…** when GitHub permits it. Confirm with an optional comment; the branch is retained. Closed PRs offer **Reopen pull request** when permitted. Closing a parent refreshes its dependent PRs. If closing succeeds but the comment cannot be confirmed, the dashboard reports that separately.
