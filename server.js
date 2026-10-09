import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createGitHub, ApiError, validateTitleUpdate, validateDraftUpdate, validateMerge } from './github.js';
import { authConfig, createAuth } from './auth.js';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/model.js', ['model.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

export function createApp({ list = createGitHub(), updateTitle = list.updateTitle, convertToDraft = list.convertToDraft, markReadyForReview = list.markReadyForReview, merge = list.merge, config = { mode: 'local' }, authOptions, deploymentEnv = process.env } = {}) {
  const sha = deploymentEnv.RAILWAY_GIT_COMMIT_SHA;
  const owner = deploymentEnv.RAILWAY_GIT_REPO_OWNER;
  const repo = deploymentEnv.RAILWAY_GIT_REPO_NAME;
  const version = /^[a-f0-9]{40}$/i.test(sha ?? '') ? {
    sha,
    url: /^[a-z0-9-]+$/i.test(owner ?? '') && /^[a-z0-9_.-]+$/i.test(repo ?? '')
      ? `https://github.com/${owner}/${repo}/commit/${sha}` : null,
  } : null;
  const localCache = new Map();
  const auth = config.mode === 'github-app' ? createAuth(config, authOptions) : null;
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
    const navigation = auth && req.method === 'GET' && ['/', '/auth/login', '/auth/callback'].includes(url.pathname);
    if ((req.headers.origin && req.headers.origin !== origin && !navigation) ||
        (req.headers['sec-fetch-site'] === 'cross-site' && !navigation)) return send(403, { error: 'Same-origin requests only.' });
    try {
      const sessionSend = (status, body) => send(status, url.pathname === '/api/session' && status === 200 && version ? { ...body, version } : body);
      if (auth && await auth.handle(req, res, url, sessionSend)) return;
      if (!auth && req.method === 'GET' && url.pathname === '/api/session') return sessionSend(200, { mode: 'local', authenticated: true });
      const session = auth && url.pathname.startsWith('/api/') ? auth.session(req) : null;
      if (auth && url.pathname.startsWith('/api/') && !session) throw new ApiError('Please sign in with GitHub.', 401);
      const activeList = session ? session.list : list;
      const cache = session ? session.cache : localCache;
      if (req.method === 'PATCH' && ['/api/pulls/title', '/api/pulls/draft', '/api/pulls/ready', '/api/pulls/merge'].includes(url.pathname)) {
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
        const statusChange = url.pathname !== '/api/pulls/title';
        input = url.pathname === '/api/pulls/merge' ? validateMerge(input) : statusChange ? validateDraftUpdate(input) : validateTitleUpdate(input);
        const actions = session ? session.list : { merge, convertToDraft, markReadyForReview, updateTitle };
        const mutate = url.pathname === '/api/pulls/merge' ? actions.merge : url.pathname === '/api/pulls/draft' ? actions.convertToDraft : url.pathname === '/api/pulls/ready' ? actions.markReadyForReview : actions.updateTitle;
        if (!mutate) throw new ApiError(statusChange ? 'Status changes are unavailable.' : 'Title editing is unavailable.', 503);
        const result = await mutate(input);
        cache.clear();
        return send(200, result);
      }
      if (req.method !== 'GET') return send(405, { error: 'Method not allowed.' });
      if (url.pathname === '/api/pulls/readiness') {
        const ids = url.searchParams.getAll('id');
        if (!ids.length || ids.length > 50 || ids.some(id => !id.trim() || id.length > 200)) return send(400, { error: 'Provide 1–50 valid PR IDs.' });
        return send(200, await activeList.mergeReadiness(ids));
      }
      if (url.pathname === '/api/pulls') {
        const scope = url.searchParams.get('scope') ?? 'authored';
        const state = url.searchParams.get('state') ?? 'open';
        const cursor = url.searchParams.get('cursor') || null;
        if (!['authored', 'involved', 'review'].includes(scope) || !['open', 'all', 'merged', 'closed'].includes(state) || (cursor?.length ?? 0) > 1000) {
          return send(400, { error: 'Invalid filter or cursor.' });
        }
        const key = JSON.stringify([scope, state, cursor]);
        let entry = cache.get(key);
        if (!entry || entry.expires < Date.now() || url.searchParams.get('refresh') === '1') {
          entry = { result: activeList({ scope, state, cursor }), expires: Date.now() + 30_000 };
          cache.set(key, entry);
          if (cache.size > 100) cache.delete(cache.keys().next().value);
        }
        try { return send(200, await entry.result); }
        catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
      }
      const asset = assets.get(url.pathname);
      if (!asset) return send(404, { error: 'Not found.' });
      const body = await readFile(new URL(`./public/${asset[0]}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
      res.end(body);
    } catch (error) {
      if (auth && error.status === 401) auth.invalidate(req, res);
      send(error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : 'Something went wrong. Please retry.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const config = authConfig();
  const app = createApp({ config });
  app.on('error', error => { console.error(`Could not start gh-pull: ${error.message}`); process.exitCode = 1; });
  app.listen(port, config.mode === 'local' ? '127.0.0.1' : (process.env.HOST || '127.0.0.1'), () => console.log(`gh-pull (${config.mode}) → ${config.origin || `http://localhost:${app.address().port}`}`));
}
