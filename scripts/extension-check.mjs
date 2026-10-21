import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';

const exec = promisify(execFile);
const os = process.platform === 'win32' ? 'windows' : process.platform;
const arch = process.arch === 'x64' ? 'amd64' : process.arch;
const binary = resolve(process.env.GH_PULL_BINARY || `dist/gh-pull-${os}-${arch}${os === 'windows' ? '.exe' : ''}`);

test('standalone extension launches, embeds assets, reuses, stops, and recovers stale state', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-pull-binary-'));
  // No real credentials, GitHub requests, Node installation, or source tree required.
  const env = { ...process.env, GH_PULL_STATE_DIR: dir, GH_TOKEN: 'fixture-unused-token', GITHUB_TOKEN: '', AUTH_MODE: 'github-app' };
  const command = (...args) => exec(binary, args, { env, cwd: tmpdir(), timeout: 25_000, maxBuffer: 2_000_000 });
  t.after(async () => { await command('stop').catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  assert.match((await command('--version')).stdout, /gh-pull/);
  assert.match((await command('--help')).stdout, /gh auth login/);
  assert.match((await command('--licenses')).stdout, /SIL OPEN FONT LICENSE/i);
  assert.match((await command('status')).stdout, /not running/);
  await assert.rejects(command('--port', 'bogus'));
  const occupied = createServer((req, res) => res.end('unrelated default port'));
  await new Promise((resolve, reject) => {
    occupied.once('error', error => error.code === 'EADDRINUSE' ? resolve() : reject(error));
    occupied.listen(3000, '127.0.0.1', resolve);
  });
  t.after(() => { occupied.close(); occupied.closeAllConnections(); });
  const [first, second] = await Promise.all([command('--no-open'), command('--no-open')]);
  const url = first.stdout.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  assert.notEqual(new URL(url).port, '3000', 'Automatically choose a free port when 3000 is occupied');
  assert.ok(second.stdout.includes(url), 'Concurrent launches must share one instance');
  const state = JSON.parse(await readFile(join(dir, 'instance.json')));
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'instance.json'))).mode & 0o777, 0o600);
  const html = await (await fetch(url)).text();
  assert.match(html, /Pull requests/);
  assert.equal((await (await fetch(url + '/api/session')).json()).mode, 'local');
  assert.equal((await fetch(url + '/api/cli')).status, 403);
  assert.equal((await fetch(url + '/api/cli', { method: 'POST' })).status, 403);
  for (const asset of ['/app.js', '/saved-views.js', '/issues.js', '/polling.js', '/theme.css', '/style.css', '/query-editor.css', '/query-editor.js', '/vendor/codemirror.js', '/favicon.svg', '/fonts/InterVariable-4.1.woff2']) {
    const response = await fetch(url + asset);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.arrayBuffer()).byteLength > 0, asset);
  }
  for (const path of ['/server.js', '/cli/main.js', '/test/cli.test.js', '/.env', '/package.json']) assert.equal((await fetch(url + path)).status, 404);
  assert.match((await command('--no-open')).stdout, /Reusing/);
  assert.match((await command('stop')).stdout, /stopped/);
  assert.match((await command('status')).stdout, /not running/);
  // Stale state pointing at an unrelated server must not let stop kill it.
  const other = createServer((req, res) => { res.writeHead(404); res.end('unrelated'); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => { other.close(); other.closeAllConnections(); });
  await writeFile(join(dir, 'instance.json'), JSON.stringify({ ...state, port: other.address().port }));
  assert.match((await command('stop')).stdout, /not running/);
  assert.equal(await (await fetch(`http://127.0.0.1:${other.address().port}`)).text(), 'unrelated');
  await assert.rejects(command('--no-open', '--port', String(other.address().port)), /port is already in use/);
  await command('--no-open');
  assert.match((await command('status')).stdout, /running at/);
});


test('GitHub CLI can install and invoke the compiled extension locally', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-pull-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'gh-pull');
  await mkdir(repo);
  const target = join(repo, process.platform === 'win32' ? 'gh-pull.exe' : 'gh-pull');
  await copyFile(binary, target);
  await chmod(target, 0o755);
  const env = {
    ...process.env, GH_CONFIG_DIR: join(dir, 'gh-config'), XDG_DATA_HOME: join(dir, 'data'),
    XDG_STATE_HOME: join(dir, 'state'), XDG_CACHE_HOME: join(dir, 'cache'),
    GH_TOKEN: 'fixture-unused-token', GITHUB_TOKEN: '',
    // Local installation should not wait for release checks or interactive prompts.
    GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1',
  };
  await exec('git', ['init', repo], { env });
  // Allow headroom for installing the large standalone binary on Windows runners.
  await exec('gh', ['extension', 'install', '.'], { env, cwd: repo, timeout: 60_000 });
  // gh uses a directory symlink on Unix and a path-pointer file on Windows.
  const installed = await stat(join(dir, 'data', 'gh', 'extensions', 'gh-pull'));
  assert.ok(installed.isDirectory() || installed.isFile(), 'Extension installation must stay inside the test directory');
  assert.match((await exec('gh', ['pull', '--version'], { env, cwd: tmpdir(), timeout: 10_000 })).stdout, /gh-pull/);
  assert.match((await exec('gh', ['pull', '--help'], { env, cwd: tmpdir(), timeout: 10_000 })).stdout, /gh pull stop/);
});
