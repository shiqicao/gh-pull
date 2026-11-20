# Transparency: local dashboard

`gh pull` reads GitHub PR data and helps the signed-in CLI user inspect and act on it. It does not use AI to decide whether to merge or post. Inserting a preset changes only the draft; the user chooses whether to post.

The local server binds to loopback. It checks Host and Origin, rejects cross-site requests, serves local browser assets, and validates mutation inputs. The CLI instance-control endpoint requires a separate control token. GitHub credentials are used server-side; normal GitHub permissions and branch protection apply. Merge requests recheck eligibility and pin the expected head commit. See [server.js](server.js), [github.js](github.js), and the [merge tests](test/merge.test.js).

See the [privacy policy](PRIVACY.md), [third-party services](THIRD_PARTY_SERVICES.md), and [local configuration](README.md#local-configuration). For earlier hosted releases see the [v1.17.0 disclosures](https://github.com/shiqicao/gh-pull/blob/v1.17.0/TRANSPARENCY.md). For questions, use the [issue tracker](https://github.com/shiqicao/gh-pull/issues) without sharing credentials or private data.
