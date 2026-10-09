# Privacy Policy

Last updated: October 9, 2026

## Scope and responsibility

This policy describes how gh-pull, including the **gh-pr-dashboard** GitHub App and the hosted dashboard at <https://gh-pull.up.railway.app/>, processes information. The hosted service is maintained by [shiqicao](https://github.com/shiqicao), who is responsible for its handling of user data. It is an independent project, not a service operated by GitHub.

If you run a separate instance, its operator controls that instance's hosting, configuration, and data handling. The local-mode differences are described below.

## Information processed

- **GitHub identity and repository metadata:** your GitHub username; repository names and permissions; PR identifiers, titles, URLs, authors, branches, commit identifiers, timestamps, labels, review decisions, reviewer identities, check results and counts, and addition/deletion counts. This can include private repository metadata when you grant access.
- **Authentication and app access:** GitHub user access and refresh tokens, token expiration times, temporary login-verification information, and app installation details such as repository access, granted permissions, and suspension status. The app receives tokens from GitHub; it does not ask for your GitHub password.
- **Requested actions:** information needed to edit your PR titles, change draft status, or merge a PR, including the PR identifier and displayed commit identifier.
- **Browser preferences:** name-color assignments and account-specific viewed-PR identifiers and timestamps. Filter and search values also appear in the page URL and may remain in browser history or appear in a request URL when the page is loaded.
- **Service and support information:** connection and request metadata processed by hosting infrastructure, and information you choose to include when contacting the maintainer or opening a GitHub issue.

The dashboard's GitHub API queries retrieve PR metadata, not repository file contents or full diffs. Links to files, checks, profiles, and PRs open GitHub separately.

## How information is used

Information is used to sign you in, display and refresh your dashboard, check access and merge readiness, remember viewed PRs and display preferences, perform actions you request, maintain service security and reliability, and respond to support requests.

gh-pull does not sell user data or use it for advertising. The application includes no advertising trackers, third-party analytics SDKs, session-replay tools, or AI inference services. PR information is not sent to an AI provider by the application.

## Sharing and service providers

**GitHub** provides authentication, installation and permission information, and repository APIs. Actions you initiate are sent to GitHub and are subject to repository permissions and rules. Information posted in the project's public issue tracker is visible to others.

**Railway** hosts the public dashboard. The hosted application's requests, responses, and server-memory data are processed on Railway infrastructure. Railway may process operational information, including connection metadata and logs, under its service policies and the deployment's configuration.

See [Third-party services](THIRD_PARTY_SERVICES.md) for details and provider privacy links. Providers may process information in countries other than your own. This policy does not promise processing within a particular country or region; contact the maintainer if you need deployment-location information before using the hosted service.

Information may also be disclosed when necessary to comply with applicable law or a valid legal request.

## Storage and retention

The current application has no database and does not write GitHub tokens or fetched PR data to application-managed persistent storage.

| Information | Storage and retention |
| --- | --- |
| Hosted login sessions, tokens, and PR caches | Held in server-process memory. Sessions are valid for up to seven days. Sign-out removes that session and its cache; restarting the process removes all in-memory sessions and caches. Expired sessions are removed during subsequent session cleanup. |
| Cached PR responses | Reused for up to 30 seconds before fetching fresh data; manual and automatic refresh bypass the cache. Thirty seconds is a freshness window, not a guaranteed deletion deadline. Cached entries may remain until replaced, evicted, or their session is removed. |
| Pending login verification | Valid for ten minutes, consumed during the callback, or removed during subsequent cleanup. |
| Browser storage | Viewed-PR markers and name colors remain until cleared by you or the browser. Signing out does not clear this local storage. |
| Provider logs and GitHub records | Governed by provider policies and applicable service settings. Clearing a gh-pull session does not delete GitHub records or Railway's operational records. |
| Support communications | Remain in the support channel where they were submitted, subject to that channel's retention and deletion controls. |

## Cookies and security

The hosted app uses first-party cookies for login verification and an opaque session identifier. The cookies are HttpOnly and SameSite=Lax, and are marked Secure when served over HTTPS. GitHub tokens stay on the server and are not placed in browser storage. The login flow uses state verification and PKCE; API requests are subject to origin checks. No system can guarantee complete security.

## Your choices and requests

- **Sign out** to end the current dashboard session and remove its in-memory credentials and cache.
- **Revoke authorization** in [Authorized GitHub Apps](https://github.com/settings/apps/authorizations) to withdraw the app's ability to act on your behalf. Sign out as well to clear the current gh-pull session immediately.
- **Restrict or uninstall the app** in [Installed GitHub Apps](https://github.com/settings/installations), or through the owning organization's settings, to change repository access. Authorization and installation are separate controls.
- **Clear site data** in your browser to remove cookies, viewed-PR markers, and name colors. Clear browsing history separately if you want to remove saved dashboard URLs.
- **Contact the maintainer** about access, correction, or deletion of information handled by gh-pull. Depending on your location, applicable law may provide additional rights, including objection or restriction of processing and complaints to a data-protection authority. Identity verification may be needed to handle a request.

Removing app access or signing out does not undo edits or merges already made on GitHub. Changes to GitHub-hosted records must be handled through GitHub's controls.

## Local and self-hosted use

In local mode, gh-pull runs on your machine and uses your GitHub CLI authentication or configured token. The application communicates with GitHub directly from that machine and does not send dashboard data to the public gh-pull instance or Railway. Your browser still stores the preferences described above. If another party hosts your instance, ask that operator about its data practices.

## Contact and changes

For non-sensitive privacy questions or to request a private contact method, open an issue at <https://github.com/shiqicao/gh-pull/issues>. Do not post tokens, private repository information, or sensitive personal information in a public issue.

Updates to this policy will be published in this repository with a revised date. Material changes will be described alongside the update.
