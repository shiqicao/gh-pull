import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createApp } from '../server.js';
import { authConfig } from '../auth.js';

for (const mode of ['local', 'github-app']) {
  test(`${mode} session exposes only validated deployment metadata`, async t => {
    const sha = 'a'.repeat(40);
    for (const [deploymentEnv, version] of [
      [{ RAILWAY_GIT_COMMIT_SHA: sha, RAILWAY_GIT_REPO_OWNER: 'shiqicao', RAILWAY_GIT_REPO_NAME: 'gh-pull', SECRET: 'never-expose' }, { sha, url: `https://github.com/shiqicao/gh-pull/commit/${sha}` }],
      [{}, undefined],
      [{ RAILWAY_GIT_COMMIT_SHA: 'invalid' }, undefined],
      [{ RAILWAY_GIT_COMMIT_SHA: sha, RAILWAY_GIT_REPO_OWNER: '../bad', RAILWAY_GIT_REPO_NAME: 'repo' }, { sha, url: null }],
    ]) {
      const config = mode === 'local' ? { mode } : authConfig({ AUTH_MODE: mode, PUBLIC_URL: 'http://localhost', GITHUB_APP_CLIENT_ID: 'test', GITHUB_APP_CLIENT_SECRET: 'test-secret' });
      const app = createApp({ config, deploymentEnv });
      await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
      const response = await new Promise((resolve, reject) => {
        const req = request(`http://127.0.0.1:${app.address().port}/api/session`, { headers: { Host: 'localhost' } }, res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject); req.end();
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      const session = JSON.parse(response.body);
      assert.deepEqual(session.version, version);
      assert.equal(session.authenticated, mode === 'local');
      assert.equal(JSON.stringify(session).includes('never-expose'), false);
    }
  });
}
