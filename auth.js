import { randomBytes, createHash } from 'node:crypto';
import { ApiError, createGitHub } from './github.js';
import { createMergeAccess } from './installation.js';

const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const loginLifetime = 10 * 60 * 1000;
const random = () => randomBytes(32).toString('base64url');

export function authConfig(env = process.env) {
  const mode = env.AUTH_MODE || 'local';
  if (!['local', 'github-app'].includes(mode)) throw new Error('AUTH_MODE must be local or github-app.');
  if (mode === 'local') return { mode };
  if (!env.PUBLIC_URL || !env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
    throw new Error('GitHub App mode requires PUBLIC_URL, GITHUB_APP_CLIENT_ID, and GITHUB_APP_CLIENT_SECRET.');
  }
  const url = new URL(env.PUBLIC_URL);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('PUBLIC_URL must be an HTTPS origin (HTTP localhost is allowed for development).');
  }
  if (env.GITHUB_APP_SLUG && !/^[a-z0-9-]+$/.test(env.GITHUB_APP_SLUG)) throw new Error('Invalid GITHUB_APP_SLUG.');
  return { mode, origin: url.origin, clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: env.GITHUB_APP_CLIENT_SECRET, slug: env.GITHUB_APP_SLUG };
}

export function createAuth(config, { fetchImpl = fetch, now = Date.now, githubFactory = createGitHub } = {}) {
  const sessions = new Map(), attempts = new Map();
  const secure = config.origin.startsWith('https:');
  const sessionName = secure ? '__Host-gh-pull-session' : 'gh-pull-session';
  const stateName = secure ? '__Host-gh-pull-state' : 'gh-pull-state';
  const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const cookieValue = (req, name) => (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  const prune = map => { for (const [id, entry] of map) if (entry.expires <= now()) map.delete(id); };
  const redirect = (res, location) => { res.writeHead(302, { Location: location }); res.end(); };
  const installUrl = config.slug ? `https://github.com/apps/${config.slug}/installations/new` : null;

  function invalidate(req, res) {
    sessions.delete(cookieValue(req, sessionName));
    res.setHeader('Set-Cookie', cookie(sessionName, '', 0));
  }

  function session(req) {
    prune(sessions);
    return sessions.get(cookieValue(req, sessionName));
  }

  async function exchange(parameters) {
    let response, data;
    try {
      response = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...parameters }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      data = await response.json();
    } catch { throw new ApiError('Could not reach GitHub authentication. Please try again.', 502); }
    if (data.error || response.status === 401 || response.status === 400) throw new ApiError('GitHub authorization expired or was denied. Please sign in again.', 401);
    if (!response.ok || typeof data.access_token !== 'string' || !data.access_token) throw new ApiError('GitHub authentication failed. Please try again.', 502);
    return {
      accessToken: data.access_token,
      tokenExpires: data.expires_in ? now() + data.expires_in * 1000 : Infinity,
      refreshToken: data.refresh_token,
      refreshExpires: data.refresh_token_expires_in ? now() + data.refresh_token_expires_in * 1000 : 0,
    };
  }

  async function tokenFor(entry) {
    if (entry.tokenExpires > now() + 60_000) return entry.accessToken;
    if (!entry.refreshToken || entry.refreshExpires <= now()) throw new ApiError('Your session expired. Please sign in again.', 401);
    // GitHub rotates refresh tokens: concurrent requests must share one exchange.
    entry.refreshing ??= exchange({ grant_type: 'refresh_token', refresh_token: entry.refreshToken })
      .then(tokens => Object.assign(entry, tokens)).finally(() => { entry.refreshing = null; });
    await entry.refreshing;
    return entry.accessToken;
  }

  return {
    session, invalidate,
    async handle(req, res, url, send) {
      if (req.method === 'GET' && url.pathname === '/api/session') {
        send(200, { mode: 'github-app', authenticated: Boolean(session(req)), installUrl });
        return true;
      }
      if (url.pathname === '/auth/login' && req.method === 'GET') {
        prune(attempts);
        if (attempts.size >= 1000) throw new ApiError('Too many pending sign-ins. Please try again later.', 429);
        const state = random(), verifier = random();
        attempts.delete(cookieValue(req, stateName));
        attempts.set(state, { verifier, expires: now() + loginLifetime });
        res.setHeader('Set-Cookie', cookie(stateName, state, loginLifetime / 1000));
        const target = new URL('https://github.com/login/oauth/authorize');
        target.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: `${config.origin}/auth/callback`, state,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
        redirect(res, target.href);
        return true;
      }
      if (url.pathname === '/auth/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state'), attempt = attempts.get(state);
        if (!attempt || attempt.expires <= now() || cookieValue(req, stateName) !== state) {
          redirect(res, '/?auth_error=state');
          return true;
        }
        attempts.delete(state);
        res.setHeader('Set-Cookie', cookie(stateName, '', 0));
        if (url.searchParams.has('error') || !url.searchParams.get('code')) {
          redirect(res, '/?auth_error=denied');
          return true;
        }
        try {
          const tokens = await exchange({ code: url.searchParams.get('code'), redirect_uri: `${config.origin}/auth/callback`, code_verifier: attempt.verifier });
          prune(sessions);
          if (sessions.size >= 10000) throw new ApiError('Too many sessions.', 503);
          sessions.delete(cookieValue(req, sessionName));
          const id = random();
          const entry = { ...tokens, expires: now() + sessionLifetime, cache: new Map() };
          entry.list = githubFactory({ getToken: () => tokenFor(entry), cacheToken: false,
            getMergeAccess: createMergeAccess({ getToken: () => tokenFor(entry), fetchImpl, installUrl }),
            authError: 'GitHub authorization expired or was revoked. Please sign in again.' });
          sessions.set(id, entry);
          res.setHeader('Set-Cookie', [cookie(stateName, '', 0), cookie(sessionName, id, sessionLifetime / 1000)]);
          redirect(res, '/');
        } catch { redirect(res, '/?auth_error=exchange'); }
        return true;
      }
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        if (req.headers.origin !== config.origin) throw new ApiError('Same-origin requests only.', 403);
        invalidate(req, res);
        send(200, { ok: true });
        return true;
      }
      if (['/auth/login', '/auth/callback', '/auth/logout', '/api/session'].includes(url.pathname)) {
        send(405, { error: 'Method not allowed.' });
        return true;
      }
      return false;
    },
  };
}
