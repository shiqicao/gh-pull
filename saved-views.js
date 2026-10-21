import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { ApiError } from './github-client.js';
import { normalizeQuery } from './public/query.js';

function history(view) {
  const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  return {
    loadCount: Number.isSafeInteger(view.loadCount) && view.loadCount >= 0 ? view.loadCount : 0,
    createdAt: timestamp(view.createdAt), lastEditedAt: timestamp(view.lastEditedAt), lastLoadedAt: timestamp(view.lastLoadedAt),
  };
}

export function rankSavedViews(views, now = Date.now()) {
  const boost = (timestamp, weight, halfLife) => timestamp ? weight * 2 ** (-Math.max(0, (now - Date.parse(timestamp)) / 86400000) / halfLife) : 0;
  const entries = views.map(view => {
    const h = history(view);
    return { view, count: h.loadCount, score: Math.log2(1 + h.loadCount) + boost(h.createdAt, 3, 7) + boost(h.lastEditedAt, 2, 3) + boost(h.lastLoadedAt, 4, 2) };
  });
  const favorites = entries.filter(entry => entry.count > 0).sort((a, b) => b.count - a.count).slice(0, 2);
  return [...favorites, ...entries.filter(entry => !favorites.includes(entry)).sort((a, b) => b.score - a.score)].map(entry => entry.view);
}

export function createSavedViewsStore(path = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'gh-pull', 'saved-views.json'), now = () => new Date().toISOString()) {
  async function read() {
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error('Invalid saved views file');
      return data;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, accounts: [] }; throw error; }
  }
  return {
    async list(account) { return (await read()).accounts.find(a => a.login === account.toLowerCase())?.views ?? []; },
    async change(account, input) {
      if (!input || !['save', 'rename', 'update', 'delete', 'restore', 'load'].includes(input.action)) throw new ApiError('Invalid saved view action.', 400);
      const { action, id } = input;
      let name, query, group;
      if (action === 'save' || action === 'rename' || action === 'restore') {
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(input.name)) throw new ApiError('Use a view name of 1–80 characters.', 400);
        name = input.name.trim();
      }
      if (action === 'save' || action === 'update' || action === 'restore') {
        group = input.group ?? 'repo';
        if (!['repo', 'author', 'status', 'checks', 'none'].includes(group)) throw new ApiError('Invalid grouping.', 400);
        try { query = normalizeQuery(input.query); } catch (error) { throw new ApiError(error.message, 400); }
      }
      if (action === 'restore' && (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) || !Number.isInteger(input.position) || input.position < 0 || input.position > 100)) throw new ApiError('Invalid view to restore.', 400);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(path, { realpath: false, retries: { retries: 5, minTimeout: 20, maxTimeout: 200 } });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const data = await read(), login = account.toLowerCase();
        let entry = data.accounts.find(a => a.login === login);
        if (!entry) { entry = { login, views: [] }; data.accounts.push(entry); }
        const views = entry.views, view = views.find(v => v.id === id);
        if (!['save', 'restore'].includes(action) && !view) throw new ApiError('This saved view no longer exists. Reload the page to refresh saved views.', 404);
        if (action === 'restore' && view) throw new ApiError('This view has already been restored.', 409);
        if (query !== undefined && views.some(v => v.id !== (action === 'save' ? null : id) && v.query === query && (v.group ?? 'repo') === group)) throw new ApiError('This query and grouping are already saved.', 409);
        if (name && views.some(v => v.id !== (action === 'save' ? null : id) && v.name.toLowerCase() === name.toLowerCase())) throw new ApiError('A view with this name already exists.', 409);
        if (action === 'save' || action === 'restore') {
          if (views.length >= 100) throw new ApiError('You can save up to 100 views.', 400);
          if (action === 'restore') views.splice(Math.min(input.position, views.length), 0, { id, name, query, group, ...history(input) });
          else views.push({ id: randomUUID(), name, query, group, loadCount: 0, createdAt: now(), lastEditedAt: null, lastLoadedAt: null });
        } else if (action === 'rename') view.name = name;
        else if (action === 'update') {
          if (view.query !== query || (view.group ?? 'repo') !== group) view.lastEditedAt = now();
          Object.assign(view, { query, group });
        } else if (action === 'load') Object.assign(view, { ...history(view), loadCount: Math.min(Number.MAX_SAFE_INTEGER, history(view).loadCount + 1), lastLoadedAt: now() });
        else views.splice(views.indexOf(view), 1);
        await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
        await rename(temporary, path);
        return views;
      } finally { await rm(temporary, { force: true }); await release(); }
    },
  };
}
