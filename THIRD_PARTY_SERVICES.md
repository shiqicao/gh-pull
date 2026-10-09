# Third-party services

Last updated: October 9, 2026

This document identifies the external services used by **gh-pull / gh-pr-dashboard** and the information involved. It accompanies the [Privacy Policy](PRIVACY.md).

## Required services

| Service | Purpose | Information involved | Where required |
| --- | --- | --- | --- |
| **GitHub** | User authentication, GitHub App installation and permission checks, PR queries, and user-requested title edits, draft changes, and merges. Also hosts the source repository, documentation, and issue tracker. | Authentication codes and tokens sent to GitHub; usernames, repository and PR metadata, installation permissions, and requested PR changes. Public support issues contain the information the submitter chooses to post. | Both hosted and local modes. Users need a GitHub.com account; private repository access and write actions depend on the user's and app's permissions. |
| **Railway** | Hosting and network infrastructure for the public dashboard at <https://gh-pull.up.railway.app/>. | Hosted requests and responses, session credentials and cached PR metadata processed in application memory, and infrastructure-level connection or operational metadata. | The public hosted service only. Users do not need a Railway account. Local mode does not require Railway; independent deployments may use a different host. |

GitHub and Railway may use their own service providers. Their policies describe those arrangements; this list identifies gh-pull's direct runtime services rather than every provider's infrastructure supplier.

## Provider policies

- GitHub: [General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) and [Subprocessors](https://docs.github.com/en/site-policy/privacy-policies/github-subprocessors).
- Railway: [Privacy Policy](https://railway.com/legal/privacy) and [Data Processing Addendum](https://railway.com/legal/dpa).

Provider retention and processing locations depend on their policies and service settings. gh-pull does not claim a specific data-residency region or a fixed retention period for provider-managed logs.

When Marketplace webhook handling is enabled, GitHub also sends signed purchase/cancellation events to the hosted service. The server verifies signatures, acknowledges free purchases, and sends token-revocation requests to GitHub when cleaning up affected sessions. This adds no service provider; see the [Privacy Policy](PRIVACY.md) for event data and retention.

## What the application does not require

The current application uses no third-party analytics, advertising, AI inference, payment-processing, external font, or session-replay service. It has no external database or application-managed object storage for PR data. Users are not required to create an account with any service other than GitHub.

Development tools and software libraries are not additional runtime data recipients. Third-party code and artwork notices are maintained in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

## Access controls and user actions

GitHub authorization identifies the user and allows the app to act on their behalf. Installation grants access to selected repositories. In hosted mode, mergeable PRs remain visible but their merge buttons are disabled if installation access, Contents write permission, or an active installation cannot be verified. Access is checked again before a merge. Local mode uses the locally configured credentials instead.

Installation and permission approval occur on GitHub. Users can follow the dashboard's app-access link, complete setup, and return to refresh. Organization access may require an owner's approval.

## Marketplace field summary

> GitHub is required for authentication, repository data, and PR actions. Railway hosts the public dashboard and processes its network requests and in-memory application data. Users need a GitHub account but no Railway account. Local/self-hosted mode requires GitHub and does not depend on the public Railway deployment. The application uses no third-party advertising, analytics, or AI services.
