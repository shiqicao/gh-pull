import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class ApiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export function createGitHubTransport({ fetchImpl = fetch, getToken = defaultToken, cacheToken = true, authError = 'GitHub login expired. Run gh auth login, then retry.' } = {}) {
  let token, retryAt = 0;
  function rateLimit(response) {
    const after = response.headers.get('retry-after');
    const seconds = after && Number.isFinite(Number(after)) ? Number(after) : (Date.parse(after) - Date.now()) / 1000;
    const reset = response.headers.get('x-ratelimit-remaining') === '0' ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : 0;
    retryAt = Math.max(Date.now() + Math.max(60, Number.isFinite(seconds) ? seconds : 0) * 1000, reset || 0);
    return throttled();
  }
  function throttled() {
    const error = new ApiError('GitHub rate limit reached. Refresh will retry automatically.', 429);
    error.retryAfter = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
    return error;
  }
  return async function request(path, { method = 'GET', body } = {}) {
    if (Date.now() < retryAt) throw throttled();
    if (!cacheToken || !token) token = await getToken();
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'gh-pull', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new ApiError('Could not reach GitHub. Check your connection and retry.'); }
    if (response.status === 401) {
      token = undefined;
      throw new ApiError(authError, 401);
    }
    if (response.status === 403 || response.status === 429) {
      if (response.status === 429 || response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0') throw rateLimit(response);
      throw new ApiError('GitHub denied the request. Check your token permissions.', 403);
    }
    if (response.status === 422) throw new ApiError('GitHub could not request this reviewer. Check repository access and reviewer eligibility.', 422);
    if (!response.ok) throw new ApiError(`GitHub returned HTTP ${response.status}. Retry shortly.`);
    if (response.status === 204) {
      if (response.headers.get('x-ratelimit-remaining') === '0') rateLimit(response);
      return null;
    }
    const payload = await response.json();
    if (payload.errors?.some(error => error.type === 'RATE_LIMITED')) throw rateLimit(response);
    // A successful response may consume the last available point. Share its cooldown
    // across tabs and query keys before sending any further requests.
    if (response.headers.get('x-ratelimit-remaining') === '0') rateLimit(response);
    if (payload.errors?.length) throw new ApiError(`GitHub: ${payload.errors.map(error => error.message).join('; ')}`);
    return payload;
  };
}

export function createGraphQLClient(options = {}) {
  const request = options.request ?? createGitHubTransport(options);
  return async (query, variables) => (await request('/graphql', { method: 'POST', body: { query, variables } })).data;
}

export async function defaultToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    const { stdout } = await exec('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 10_000 });
    if (stdout.trim()) return stdout.trim();
  } catch { /* Return actionable instructions without exposing CLI output. */ }
  throw new ApiError('Sign in with gh auth login, or set GH_TOKEN before starting the server, then retry.', 401);
}
