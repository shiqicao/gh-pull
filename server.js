import { validateReviewerChange } from './reviewer-management.js';
import { publicAssets } from './public-assets.js';
import { createSavedViewsStore, rankSavedViews } from './saved-views.js';
import { isSea, getAsset } from 'node:sea';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { toGitHubQuery, repositoryScope } from './public/query.js';
import { createGitHub, ApiError, validateTitleUpdate, validateDraftUpdate, validateMerge, validateReviewDismissal, validateClose } from './github.js';
import { cachedRequest } from './request-cache.js';
import { authConfig, createAuth } from './auth.js';
import { createMarketplaceWebhook } from './marketplace.js';
import { createUpdateCheck } from './extension-updates.js';

const assets = new Map(publicAssets.filter(([, type]) => type).map(([file, type]) =>
  [file === 'index.html' ? '/' : `/${file}`, [file, type]]));

const mutations = new Map([
  ['/api/pulls/reviewers', { method: 'changeReviewer', validate: validateReviewerChange, unavailable: 'Reviewer management is unavailable.' }],
  ['/api/pulls/close', { method: 'closePull', validate: validateClose, unavailable: 'Closing PRs is unavailable.' }],
  ['/api/pulls/reopen', { method: 'reopenPull', validate: validateDraftUpdate, unavailable: 'Reopening PRs is unavailable.' }],
  ['/api/pulls/revoke', { method: 'dismissReview', validate: validateReviewDismissal, unavailable: 'Review revocation is unavailable.' }],
  ['/api/pulls/title', { method: 'updateTitle', validate: validateTitleUpdate, unavailable: 'Title editing is unavailable.' }],
  ['/api/pulls/draft', { method: 'convertToDraft', validate: validateDraftUpdate, unavailable: 'Status changes are unavailable.' }],
  ['/api/pulls/ready', { method: 'markReadyForReview', validate: validateDraftUpdate, unavailable: 'Status changes are unavailable.' }],
  ['/api/pulls/merge', { method: 'merge', validate: validateMerge, unavailable: 'Status changes are unavailable.' }],
]);

export function createApp({ savedViews = createSavedViewsStore(), list = createGitHub(), updateTitle = list.updateTitle, convertToDraft = list.convertToDraft, markReadyForReview = list.markReadyForReview, merge = list.merge, dismissReview = list.dismissReview, closePull = list.closePull, reopenPull = list.reopenPull, changeReviewer = list.changeReviewer, config = { mode: 'local' }, localControl, authOptions, deploymentEnv = process.env } = {}) {
  const build = config.mode === 'local' ? localControl?.version : null;
  const checkUpdate = createUpdateCheck(build);
  const version = deploymentVersion(deploymentEnv, build);
  const localCache = new Map();
  const subscribers = new Map();
  const auth = config.mode === 'github-app' ? createAuth(config, authOptions) : null;
  const marketplace = auth ? createMarketplaceWebhook({ secret: config.marketplaceWebhookSecret, cancel: auth.cancelMarketplace }) : null;
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const host = req.headers.host ?? '';
    const origin = auth ? config.origin : `http://${host}`;
    if (auth ? host !== new URL(origin).host : !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return send(403, { error: 'Invalid request host.' });
    let url;
    try { url = new URL(req.url, origin); }
    catch { return send(400, { error: 'Invalid request URL.' }); }
    if (url.origin !== origin) return send(403, { error: 'Invalid request origin.' });
    if (url.pathname === '/webhooks/marketplace') {
      if (!marketplace) return send(404, { error: 'Not found.' });
      try { return send(200, await marketplace(req)); }
      catch (error) { return send(error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : 'Webhook processing failed. Redeliver to retry.' }); }
    }
    const navigation = auth && req.method === 'GET' && ['/', '/auth/login', '/auth/callback'].includes(url.pathname);
    if ((req.headers.origin && req.headers.origin !== origin && !navigation) ||
        (req.headers['sec-fetch-site'] === 'cross-site' && !navigation)) return send(403, { error: 'Same-origin requests only.' });
    if (!auth && localControl && url.pathname === '/api/cli') {
      if (req.headers.authorization !== `Bearer ${localControl.token}`) return send(403, { error: 'Invalid control token.' });
      if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'Method not allowed.' });
      send(200, { app: 'gh-pull', version: localControl.version });
      if (req.method === 'POST') res.once('finish', () => localControl.stop().catch(() => { process.exitCode = 1; }));
      return;
    }
    try {
      if (!auth && build && req.method === 'GET' && url.pathname === '/api/updates') return send(200, { update: await checkUpdate() });
      const sessionSend = (status, body) => send(status, url.pathname === '/api/session' && status === 200 && version ? { ...body, version } : body);
      if (auth && await auth.handle(req, res, url, sessionSend)) return;
      if (!auth && req.method === 'GET' && url.pathname === '/api/session') return sessionSend(200, { mode: 'local', authenticated: true });
      const session = auth && url.pathname.startsWith('/api/') ? auth.session(req) : null;
      if (auth && url.pathname.startsWith('/api/') && !session) throw new ApiError('Please sign in with GitHub.', 401);
      const activeList = session ? session.list : list;
      const cache = session ? session.cache : localCache;
      if (url.pathname === '/api/saved-views') {
        if (auth) return send(404, { error: 'Saved views are available in local mode.' });
        if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'Method not allowed.' });
        let input;
        if (req.method === 'POST') {
          if (req.headers.origin !== origin) return send(403, { error: 'Same-origin requests only.' });
          if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return send(415, { error: 'Expected application/json.' });
          const chunks = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 8192) throw new ApiError('Request body is too large.', 413);
            chunks.push(chunk);
          }
          try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { throw new ApiError('Invalid JSON body.', 400); }
        }
        if (!activeList.viewer) throw new ApiError('Could not identify the GitHub account.', 503);
        const account = await activeList.viewer();
        if (input && input.account !== account) throw new ApiError('GitHub account changed. Reopen Views and try again.', 409);
        return send(200, { account, views: req.method === 'GET' ? rankSavedViews(await savedViews.list(account)) : await savedViews.change(account, input) });
      }
      const mutation = mutations.get(url.pathname);
      if (req.method === 'PATCH' && mutation) {
        if (req.headers.origin !== origin) return send(403, { error: 'Same-origin requests only.' });
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return send(415, { error: 'Expected application/json.' });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8192) throw new ApiError('Request body is too large.', 413);
          chunks.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError('Invalid JSON body.', 400); }
        input = mutation.validate(input);
        const actions = session ? session.list : { merge, convertToDraft, markReadyForReview, updateTitle, dismissReview, closePull, reopenPull, changeReviewer };
        return await handleMutation(input, mutation, actions, cache, subscribers, send);
      }
      if (req.method !== 'GET') return send(405, { error: 'Method not allowed.' });
      if (url.pathname === '/api/events') {
        return handleEvents(res, cache, subscribers);
      }
      if (url.pathname === '/api/pulls/reviewers') {
        if (!activeList.reviewerSuggestions) throw new ApiError('Reviewer search is unavailable.', 503);
        return send(200, await activeList.reviewerSuggestions(url.searchParams.get('id'), url.searchParams.get('q') ?? ''));
      }
      if (url.pathname === '/api/repositories') {
        let scope;
        try { scope = repositoryScope(url.searchParams.get('q') ?? ''); }
        catch (error) { return send(400, { error: error.message }); }
        if (!activeList.repositories) return send(200, { repositories: [], limited: false });
        return send(200, await cachedRequest(cache, `repositories:${JSON.stringify(scope)}`,
          () => activeList.repositories(scope), { ttl: 5 * 60_000 }));
      }
      if (['/api/pulls/readiness', '/api/pulls/status', '/api/pulls/review-counts'].includes(url.pathname)) {
        return await handleStatus(url, activeList, cache, send);
      }
      if (url.pathname === '/api/pulls') {
        return await handleList(url, activeList, cache, send);
      }
      return await serveAsset(url, res, send);
    } catch (error) {
      if (auth && error.status === 401) auth.invalidate(req, res);
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      send(error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : 'Something went wrong. Please retry.' });
    }
  });
}

function deploymentVersion(env, build) {
  if (build) return { label: build,
    url: build.startsWith('v') ? `https://github.com/shiqicao/gh-pull/releases/tag/${encodeURIComponent(build)}` : null };
  const sha = env.RAILWAY_GIT_COMMIT_SHA, owner = env.RAILWAY_GIT_REPO_OWNER, repo = env.RAILWAY_GIT_REPO_NAME;
  if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) return null;
  return { sha, url: /^[a-z0-9-]+$/i.test(owner ?? '') && /^[a-z0-9_.-]+$/i.test(repo ?? '')
    ? `https://github.com/${owner}/${repo}/commit/${sha}` : null };
}

async function handleMutation(input, mutation, actions, cache, subscribers, send) {
  const mutate = actions[mutation.method];
  if (!mutate) throw new ApiError(mutation.unavailable, 503);
  const result = await mutate(input);
  cache.clear();
  for (const stream of subscribers.get(cache) ?? []) stream.write('event: invalidate\ndata: {}\n\n');
  return send(200, result);
}

function handleEvents(res, cache, subscribers) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  const streams = subscribers.get(cache) ?? new Set();
  subscribers.set(cache, streams); streams.add(res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(heartbeat); streams.delete(res);
    if (!streams.size) subscribers.delete(cache);
  });
}

async function handleStatus(url, activeList, cache, send) {
  const ids = url.searchParams.getAll('id');
  if (!ids.length || ids.length > 50 || ids.some(id => !id.trim() || id.length > 200)) return send(400, { error: 'Provide 1–50 valid PR IDs.' });
  const kind = url.pathname.endsWith('/review-counts') ? 'reviewCounts' : url.pathname.endsWith('/status') ? 'status' : 'mergeReadiness';
  if (!activeList[kind]) return send(200, { items: [] });
  const key = `${kind}:${JSON.stringify([...new Set(ids)].sort())}`;
  return send(200, await cachedRequest(cache, key, async () => {
    const result = await activeList[kind](ids);
    // A node refresh can reveal changes before search's cached page expires.
    // Reconcile query membership through a fresh search on the next list read.
    if (kind === 'status') for (const cachedKey of cache.keys()) {
      if (cachedKey.startsWith('list:')) cache.delete(cachedKey);
    }
    return result;
  }, { ttl: kind === 'reviewCounts' ? 60_000 : kind === 'status' ? 10_000 : 1000 }));
}

async function handleList(url, activeList, cache, send) {
  const scope = url.searchParams.get('scope') ?? 'authored';
  const state = url.searchParams.get('state') ?? 'open';
  const cursor = url.searchParams.get('cursor') || null;
  if (!['authored', 'involved', 'review'].includes(scope) || !['open', 'all', 'merged', 'closed'].includes(state) || (cursor?.length ?? 0) > 1000) {
    return send(400, { error: 'Invalid filter or cursor.' });
  }
  let query;
  if (url.searchParams.has('q')) {
    try { query = toGitHubQuery(url.searchParams.get('q')); }
    catch (error) { return send(400, { error: error.message }); }
  }
  const key = `list:${JSON.stringify(query === undefined ? [scope, state, cursor] : ['query', query, cursor])}`;
  return send(200, await cachedRequest(cache, key,
    () => activeList(query === undefined ? { scope, state, cursor } : { query, cursor }),
    { ttl: 25_000, force: url.searchParams.get('refresh') === '1' }));
}

async function serveAsset(url, res, send) {
  const asset = assets.get(url.pathname);
  if (!asset) return send(404, { error: 'Not found.' });
  let body = isSea() ? Buffer.from(getAsset(`public/${asset[0]}`)) : await readFile(new URL(`./public/${asset[0]}`, import.meta.url));
  if (url.pathname === '/') {
    // CodeMirror mounts nonce-authorized style sheets. Browsers also copy
    // token colors into style attributes while editing contenteditable text.
    // Allow those attributes only; scripts and style sheets stay restricted.
    const nonce = randomBytes(18).toString('base64');
    res.setHeader('Content-Security-Policy', res.getHeader('Content-Security-Policy').replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'`));
    body = body.toString('utf8').replace('STYLE_NONCE', nonce);
  }
  if (asset[1].startsWith('font/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.writeHead(200, { 'Content-Type': asset[1].startsWith('font/') ? asset[1] : `${asset[1]}; charset=utf-8` });
  res.end(body);
}

if (!isSea() && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const config = authConfig();
  const app = createApp({ config });
  app.on('error', error => { console.error(`Could not start gh-pull: ${error.message}`); process.exitCode = 1; });
  app.listen(port, config.mode === 'local' ? '127.0.0.1' : (process.env.HOST || '127.0.0.1'), () => console.log(`gh-pull (${config.mode}) → ${config.origin || `http://localhost:${app.address().port}`}`));
}
