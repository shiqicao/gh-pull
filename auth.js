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
  return { mode, origin: url.origin, clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: env.GITHUB_APP_CLIENT_SECRET, slug: env.GITHUB_APP_SLUG, marketplaceWebhookSecret: env.GITHUB_MARKETPLACE_WEBHOOK_SECRET };
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
    forgetSession(req);
    res.setHeader('Set-Cookie', cookie(sessionName, '', 0));
  }

  function forgetSession(req) {
    const id = cookieValue(req, sessionName);
    // Keep failed cancellation credentials inaccessible but available for redelivery.
    if (!sessions.get(id)?.cancelled) sessions.delete(id);
  }

  function session(req) {
    prune(sessions);
    const entry = sessions.get(cookieValue(req, sessionName));
    return entry?.cancelled ? undefined : entry;
  }

  async function exchange(parameters, timeoutMs = 30_000) {
    let response, data;
    try {
      response = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...parameters }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
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
    if (entry.cancelled) throw new ApiError('This session has ended. Please sign in again.', 401);
    if (entry.tokenExpires > now() + 60_000) return entry.accessToken;
    if (!entry.refreshToken || entry.refreshExpires <= now()) throw new ApiError('Your session expired. Please sign in again.', 401);
    // GitHub rotates refresh tokens: concurrent requests must share one exchange.
    entry.refreshing ??= exchange({ grant_type: 'refresh_token', refresh_token: entry.refreshToken })
      .then(tokens => Object.assign(entry, tokens)).finally(() => { entry.refreshing = null; });
    await entry.refreshing;
    if (entry.cancelled) throw new ApiError('This session has ended. Please sign in again.', 401);
    return entry.accessToken;
  }

  async function marketplaceIdentity(accessToken) {
    const response = await fetchImpl('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'gh-pull' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new ApiError('Could not verify GitHub identity. Please sign in again.', 401);
    const user = await response.json();
    if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string') throw new ApiError('Invalid GitHub identity.', 502);
    return { id: user.id, login: user.login };
  }

  async function cancelMarketplace(account) {
    const owner = account.login.toLowerCase();
    const affected = [...sessions].filter(([, entry]) => account.type === 'User'
      ? entry.identity?.id === account.id || entry.owners?.has(owner)
      : entry.owners?.has(owner));
    // End affected sessions before contacting GitHub. Failed revocations remain
    // inaccessible in memory so a redelivery can retry them.
    for (const [, entry] of affected) { entry.cancelled = true; entry.cache.clear(); }
    const results = await Promise.allSettled(affected.map(async ([id, entry]) => {
      // A normal refresh can take 30 seconds. Retry after rotation instead of
      // exceeding GitHub's webhook response timeout.
      if (entry.refreshing) throw new Error('Token refresh in progress.');
      if (entry.tokenExpires <= now() && entry.refreshToken && entry.refreshExpires > now()) {
        try { Object.assign(entry, await exchange({ grant_type: 'refresh_token', refresh_token: entry.refreshToken }, 4000)); }
        catch (error) { if (error.status !== 401) throw error; sessions.delete(id); return; }
      }
      if (entry.tokenExpires > now()) {
        const response = await fetchImpl(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
          method: 'DELETE', headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'gh-pull' },
          body: JSON.stringify({ access_token: entry.accessToken }), signal: AbortSignal.timeout(4000),
        });
        if (response.status !== 204 && response.status !== 404) throw new Error('Token revocation failed.');
      }
      sessions.delete(id);
    }));
    if (results.some(result => result.status === 'rejected')) throw new ApiError('Cancellation cleanup incomplete. Redeliver this webhook to retry.', 502);
  }

  return {
    session, invalidate, cancelMarketplace,
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
          forgetSession(req);
          const id = random();
          const identity = config.marketplaceWebhookSecret ? await marketplaceIdentity(tokens.accessToken) : undefined;
          const entry = { ...tokens, identity, owners: new Set(), expires: now() + sessionLifetime, cache: new Map() };
          const checkAccess = createMergeAccess({ getToken: () => tokenFor(entry), fetchImpl, installUrl });
          const github = githubFactory({ getToken: () => tokenFor(entry), cacheToken: false,
            getMergeAccess: repos => {
              for (const repo of repos) entry.owners.add(repo.split('/')[0].toLowerCase());
              return checkAccess(repos);
            },
            authError: 'GitHub authorization expired or was revoked. Please sign in again.' });
          entry.list = Object.assign(async options => {
            const result = await github(options);
            for (const pr of result.items ?? []) entry.owners.add(pr.repo.split('/')[0].toLowerCase());
            if (entry.cancelled) throw new ApiError('This session has ended. Please sign in again.', 401);
            return result;
          }, github);
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
