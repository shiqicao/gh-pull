# gh-pull

much better github pr dashboard

A fast local dashboard for your GitHub pull requests. Plain JavaScript, native browser controls, minimal CSS, and a Node server. No runtime dependencies, installation, or build step.

![gh-pull dashboard showing fictional demo pull requests](docs/demo.png)

## Run

Requires Node.js 22+ and a GitHub.com account.

```sh
gh auth login
npm start
```

Open <http://localhost:3000>. The server reads your existing GitHub CLI credential. Alternatively, supply `GH_TOKEN` or `GITHUB_TOKEN` in the server environment; the token needs read access to the repositories you want to see. Credentials never go to the browser. The server binds only to `127.0.0.1`.

Set `PORT` to change the port. Both `npm start` and `npm run dev` automatically restart the server when backend files change; reload the browser to pick up frontend edits. Use `node server.js` if you specifically want to disable automatic restarts.

## Features

- Created by me, involving me, and review-requested views.
- Open (including drafts), merged, closed without merging, or all PRs.
- Repository, author, status, check summary, review decision, labels, changed-line counts, and update time.
- Pending checks show a passed/total count, such as “Checks pending · 1/8”, including check runs and commit statuses. Skipped and neutral checks are not counted as passed.
- Reviewers on the right of each PR, with the same username-based colors as authors and a small colored status icon beside each name. Empty reviewer sections are hidden. Includes teams and deduplicates re-requested reviewers. Up to 100 review requests and 100 latest reviews per PR; a GitHub link appears if there are more.
- Name colors use 12 evenly spaced OKLCH hues. Initial names are sorted and distributed across the palette; new people receive the most separated unused color without changing existing assignments. Assignments persist in this browser. Beyond 12 people, colors are reused evenly; names remain visible to identify people. Clearing browser storage resets assignments; with storage disabled, assignments last for the session.
- Group by repository, author, status, or checks; collapse groups.
- Search loaded PRs by title, repository, author, number, or label; sort by creation or update time.
- Open PR titles in a new tab.
- Edit your own PR titles with the pencil icon beside the title. Save (or Enter) updates GitHub; Cancel (or Escape) discards the edit. Titles must be 1–256 characters on one line. Failed saves retain your draft. The server verifies authorship and checks for a changed title before submitting; your token must have permission to update the PR.
- Click Open on your own PR to convert it to a draft, or click Draft to mark it ready for review (Open). The badge changes after GitHub confirms; failures show an error and can be retried. Other authors' PRs and closed or merged PRs have non-interactive status badges.
- Merge your own ready PRs with a green button showing the repository’s preferred merge method. The server rechecks readiness and permissions and pins the merge to the displayed commit. Drafts, blocked PRs, merge queues, and stacked PRs do not show this action; use GitHub for queue or stack workflows. Refresh after marking a draft ready to update merge readiness.
- Repository names in group headings and PR metadata open the repository in a new tab without marking a PR as viewed.
- Copy a PR URL with the copy icon between its status badge and file-diff link; a check mark confirms it was copied.
- The source branch is shown in each PR's metadata. Click its name or copy icon to copy the exact branch name; a check mark confirms success.
- PRs with new updates have brighter, bolder titles; viewed titles are muted. Opening the title, diff, or checks from this dashboard marks the displayed update as viewed (including Ctrl/Cmd-click and middle-click); copying and repository links do not. Newer GitHub `updatedAt` timestamps brighten the title again when data refreshes. Unopened PRs start highlighted. Viewed state is saved per GitHub account in this browser and synchronized across dashboard tabs; reading directly on GitHub or in another browser is not tracked.
- Click the file-diff icon (a document with plus/minus marks) next to a title to open the code diff directly in a new tab.
- Shareable filter URLs, responsive layout, keyboard-accessible controls, and light/dark system colors.
- Pages of 50 PRs, loaded on demand; a 30-second server memory cache. Auto-refresh runs 60 seconds after each load finishes. The Refresh button counts down between loads and is disabled with “Refreshing…” while loading. Manual and automatic refresh keep existing PRs visible until fresh data arrives, bypass the current page's cache, and reset pagination on success. Failed refreshes keep the existing data.

Created-by-me pagination covers the full authored history without GitHub's search ceiling. Involving-me and review-requested views use GitHub search, which exposes at most 1,000 matches; the dashboard shows a notice when this applies. Search and grouping operate on loaded pages. Labels show the first ten per PR. Check status is the aggregate for the latest commit, not an individual job listing. Only the username-to-color mapping and account-specific viewed PR IDs/timestamps are saved in browser storage; PR contents and credentials are not stored there. With browser storage disabled, viewed state lasts only for the current page session.

The GraphQL fields follow [GitHub's pull request API](https://docs.github.com/en/graphql/reference/pulls). GitHub writes happen when you save a title edit click your PR's Open/Draft badge to change its draft status, or click a merge button. GitHub Enterprise hosts are not currently supported.

## Verify

```sh
npm run check
npm test
```

Tests use Node's built-in test runner with mocked GitHub responses; they do not need credentials or network access.
