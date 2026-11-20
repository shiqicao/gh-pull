# Privacy policy: local gh-pull

This document covers the local-only version of gh-pull. For previous versions, including the hosted application, see the [v1.17.0 policy](https://github.com/shiqicao/gh-pull/blob/v1.17.0/PRIVACY.md).

`gh pull` starts a server on your machine. It uses credentials from GitHub CLI or your configured `GH_TOKEN` / `GITHUB_TOKEN` to request repository, PR, issue, review and check data from GitHub. Actions you submit in the dashboard, including comments and merges, are sent to GitHub under your account. Release builds also check GitHub for extension updates. There is no hosted gh-pull login, session cookie, Marketplace webhook, analytics or advertising service in this version.

PR data and request caches are held in process memory. Saved views and comment presets persist in your selected config file, including text you enter. Dashboard preferences are kept in your browser. The launcher stores private instance-control state separately from GitHub credentials. See [Local data and privacy](README.md#local-data-and-privacy) for locations and controls. Stop the server to clear process memory; clear browser site data or remove the appropriate local config to erase preferences. Removing local data does not undo changes on GitHub. Manage tokens and repository access through GitHub and GitHub CLI.

For non-sensitive privacy questions or to request a private contact method, [contact the maintainer](https://github.com/shiqicao/gh-pull/issues). Do not include credentials or private repository data in public issues.
