import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createGitHub, ApiError, validateTitleUpdate, validateDraftUpdate } from './github.js';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/model.js', ['model.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);

export function createApp({ list = createGitHub(), updateTitle = list.updateTitle, convertToDraft = list.convertToDraft, markReadyForReview = list.markReadyForReview } = {}) {
  const cache = new Map();
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    // This server holds a local GitHub credential: reject cross-origin and DNS-rebinding requests.
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) ||
        req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Local requests only.' });
    const url = new URL(req.url, `http://${host}`);
    try {
      if (req.method === 'PATCH' && ['/api/pulls/title', '/api/pulls/draft', '/api/pulls/ready'].includes(url.pathname)) {
        if (req.headers.origin !== `http://${host}`) return send(403, { error: 'Same-origin requests only.' });
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
        input = statusChange ? validateDraftUpdate(input) : validateTitleUpdate(input);
        const mutate = url.pathname === '/api/pulls/draft' ? convertToDraft : url.pathname === '/api/pulls/ready' ? markReadyForReview : updateTitle;
        if (!mutate) throw new ApiError(statusChange ? 'Status changes are unavailable.' : 'Title editing is unavailable.', 503);
        const result = await mutate(input);
        cache.clear();
        return send(200, result);
      }
      if (req.method !== 'GET') return send(405, { error: 'Method not allowed.' });
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
          entry = { result: list({ scope, state, cursor }), expires: Date.now() + 30_000 };
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
      send(error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : 'Something went wrong. Please retry.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.on('error', error => { console.error(`Could not start gh-pull: ${error.message}`); process.exitCode = 1; });
  app.listen(port, '127.0.0.1', () => console.log(`gh-pull → http://localhost:${app.address().port}`));
}
