import { ApiError } from './github.js';

const githubUrl = value => {
  try { const url = new URL(value); return url.origin === 'https://github.com' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
};

// Each check uses the current user's token and fresh installation permissions.
export function createMergeAccess({ getToken, fetchImpl = fetch, installUrl = null }) {
  return async repos => {
    const blocked = (reason, message, url = installUrl, action = 'Install GitHub App') => ({ allowed: false, reason, message, url, action });
    const unknown = () => blocked('unverified', 'Could not verify app access. Refresh to try again.', null, null);
    const results = new Map();
    if (!repos.length) return results;
    let token;
    async function pages(path, key) {
      const values = [];
      for (let page = 1; ; page++) {
        const response = await fetchImpl(`https://api.github.com${path}?per_page=100&page=${page}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'gh-pull' },
          signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 401) throw new ApiError('GitHub authorization expired or was revoked. Please sign in again.', 401);
        if (!response.ok) throw new Error('Installation access unavailable.');
        const data = await response.json();
        if (!Array.isArray(data[key])) throw new Error('Invalid installation response.');
        values.push(...data[key]);
        if (data[key].length < 100) return values;
      }
    }
    let installations;
    try {
      token = await getToken();
      installations = await pages('/user/installations', 'installations');
    } catch (error) {
      if (error.status === 401) throw error;
      return new Map(repos.map(repo => [repo, unknown()]));
    }
    const slug = installations.find(item => /^[a-z0-9-]+$/.test(item.app_slug ?? ''))?.app_slug;
    const newInstallation = installUrl || (slug ? `https://github.com/apps/${slug}/installations/new` : null);
    const owners = new Map();
    for (const repo of repos) {
      const owner = repo.split('/')[0].toLowerCase();
      if (!owners.has(owner)) owners.set(owner, []);
      owners.get(owner).push(repo);
    }
    await Promise.all([...owners].map(async ([owner, names]) => {
      const installation = installations.find(item => item.account?.login?.toLowerCase() === owner);
      let access;
      const manageUrl = githubUrl(installation?.html_url) || newInstallation;
      if (!installation) {
        access = blocked('not_installed', 'Install the GitHub App for this repository to merge here. Organization access may require owner approval.', newInstallation);
      } else if (installation.suspended_at) {
        access = blocked('suspended', 'The GitHub App installation is suspended. Ask the account owner to restore access.', manageUrl, 'Manage app access');
      } else if (installation.permissions?.contents !== 'write') {
        access = blocked('permission_required', 'Approve Contents: read and write for the GitHub App installation to enable merging.', manageUrl, 'Review app permissions');
      } else {
        try {
          const repositories = await pages(`/user/installations/${installation.id}/repositories`, 'repositories');
          const accessible = new Map(repositories.map(repo => [repo.full_name?.toLowerCase(), repo]));
          for (const name of names) {
            const repository = accessible.get(name.toLowerCase());
            results.set(name, !repository
              ? blocked('repository_required', 'Give the GitHub App access to this repository to merge here. Organization access may require owner approval.', manageUrl, 'Grant repository access')
              : { allowed: true });
          }
          return;
        } catch (error) {
          if (error.status === 401) throw error;
          access = unknown();
        }
      }
      for (const name of names) results.set(name, access);
    }));
    return results;
  };
}
