# Transparency disclosures

Last updated: October 9, 2026

## App purpose and AI use

gh-pull / gh-pr-dashboard is a GitHub pull request dashboard. It displays PR metadata and lets signed-in users request supported actions on their own PRs. It is not a Copilot Extension and does not use AI models, generate code, perform autonomous code reviews, train models, or send repository data to an AI provider. Background automation is limited to refreshing dashboard data and checking access and merge readiness; it does not automatically merge PRs.

## Permissions and risk management

The full feature set requests Pull requests read-and-write permission for title and draft-status updates, Contents read-and-write permission for merging, and read access to Checks, Commit statuses, and Metadata. Although Contents permission is broader than a single merge operation, the dashboard does not provide arbitrary file-editing or repository-administration actions. Its normal data queries retrieve PR metadata rather than source-file contents or full diffs.

Write operations require an explicit user action. The server verifies that the signed-in user is the PR author before title edits, draft changes, or merges. It checks the current title before overwriting it and pins merge requests to the commit displayed to the user. It rechecks GitHub merge readiness, permitted merge methods, and user permissions. The app excludes drafts, blocked PRs, merge queues, and stacked PRs from its merge action. GitHub performs the final authorization and repository-rule enforcement.

In hosted mode, the app separately verifies installation access, Contents write permission, and suspension status. A mergeable PR remains visible with a disabled merge button when access is missing or cannot be verified. The server checks installation access again before submitting a merge. Local mode uses the operator's GitHub CLI credentials or configured token and does not require a GitHub App installation.

## Authentication and application security

Hosted sign-in uses GitHub's OAuth authorization flow with PKCE and state verification. Access and refresh tokens remain on the server; the browser receives an opaque session identifier in an HttpOnly, SameSite=Lax cookie, marked Secure on HTTPS. Expiring user tokens are refreshed server-side. Each hosted session has a separate GitHub client and PR cache, with no fallback to the server owner's credentials.

The application validates request hosts and origins, requires a matching Origin and JSON content type for PR mutations, limits request-body size, and validates action inputs. It sends a restrictive Content Security Policy and no-store response headers. Local mode binds to the loopback interface by default.

These controls reduce risk but do not eliminate it. Merges and other requested changes affect GitHub records; account compromise, excessive repository grants, or incorrect user actions can still cause harm. Users and repository owners can restrict installations, revoke authorization, and apply repository rules.

## Data governance and third parties

The maintainer identified in the [Privacy Policy](PRIVACY.md) is responsible for the hosted application's handling of user data. Data is used to provide the dashboard, authenticate users, check access, perform requested actions, and support the service.

GitHub supplies authentication and repository APIs; Railway hosts the public dashboard. Tokens and PR caches are held in server-process memory, with no application-managed persistent database. Sessions expire after up to seven days, are removed on sign-out, and are lost on restart. Cache freshness is 30 seconds, which is not a guaranteed deletion deadline. Expired entries are removed during subsequent cleanup or replacement. Browser storage retains viewed-PR markers and name colors until cleared. Provider-managed logs and GitHub records have separate retention rules.

The app includes no advertising, analytics, session-replay, or AI-provider integrations. See the [Privacy Policy](PRIVACY.md) and [Third-party services](THIRD_PARTY_SERVICES.md) for data categories, retention details, access-revocation controls, and provider policy links.

## Compliance claims and verification

No independent security audit, penetration-test report, SOC 2 report, ISO 27001 certification, or other compliance certification is currently offered for gh-pull. No EU AI Act conformity assessment or certification is claimed. This disclosure describes the application's implementation; it is not a claim that the application has been certified or independently verified as compliant with a legal or industry framework. Any certifications held by hosting or API providers do not certify gh-pull itself.

The following public implementation and automated-test materials are available for review. They are engineering evidence, not independent compliance reports:

- [Authentication and sessions](auth.js) and [authentication tests](test/auth.test.js).
- [HTTP request controls](server.js) and [application tests](test/app.test.js).
- [GitHub actions and merge safeguards](github.js) and [merge tests](test/merge.test.js).
- [Installation access checks](installation.js) and [installation tests](test/installation.test.js).
- [Source repository and change history](https://github.com/shiqicao/gh-pull).

## Contact

For non-sensitive questions about these disclosures, use the [project issue tracker](https://github.com/shiqicao/gh-pull/issues). Request a private contact method before sharing sensitive information. Do not publish credentials, private repository data, or exploit details in a public issue.
