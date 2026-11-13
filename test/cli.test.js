import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { parseArgs, serve, runCLI } from '../cli/launcher.js';
import { createApp } from '../server.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gh-pull-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const instance = await serve({ dir, port: 0 }, { makeApp: options => createApp({ ...options, list: async () => ({ items: [], viewer: 'fixture' }) }) });
  t.after(instance.stop);
  return { dir, instance, url: `http://127.0.0.1:${instance.port}` };
}

test('CLI validates commands and ports without silently accepting mistakes', () => {
  assert.deepEqual(parseArgs([]), { command: 'start', open: true, foreground: false });
  assert.deepEqual(parseArgs(['--no-open', '--port', '3456']), { command: 'start', open: false, foreground: false, port: 3456 });
  for (const args of [['--port'], ['--port', '0'], ['--port', '65536'], ['--port', '12abc'], ['stop', '--port', '3000'], ['status', 'stop'], ['--serve']]) assert.throws(() => parseArgs(args));
});

test('local control needs a private token and rejects cross-origin shutdown', async t => {
  const { dir, instance, url } = await fixture(t);
  const state = JSON.parse(await readFile(join(dir, 'instance.json')));
  assert.equal(instance.app.address().address, '127.0.0.1');
  assert.equal((await fetch(url + '/api/cli')).status, 403);
  const headers = { Authorization: `Bearer ${state.token}` };
  assert.equal((await fetch(url + '/api/cli', { headers: { ...headers, Origin: 'https://evil.example' }, method: 'POST' })).status, 403);
  assert.equal((await fetch(url + '/api/cli', { headers, method: 'DELETE' })).status, 405);
  assert.equal((await (await fetch(url + '/api/cli', { headers })).json()).app, 'gh-pull');
  assert.equal((await fetch(url + '/')).status, 200);
});

test('launcher reuses the running app, opens its URL, and stops only the authenticated instance', async t => {
  const { dir, instance, url } = await fixture(t);
  const output = [], opened = [];
  const options = { dir, output: line => output.push(line), open: async url => opened.push(url), authenticate: () => { throw new Error('Existing instance must be reused'); } };
  await runCLI([], options);
  assert.deepEqual(opened, [url]);
  await runCLI(['--no-open'], options);
  assert.equal(opened.length, 1);
  await assert.rejects(runCLI(['--port', String(instance.port === 3001 ? 3002 : 3001)], options), /Already running/);
  await runCLI(['status'], options);
  assert.match(output.at(-1), /running at/);
  await runCLI(['stop'], options);
  assert.equal(output.at(-1), 'gh-pull stopped.');
  await runCLI(['status'], options);
  assert.equal(output.at(-1), 'gh-pull is not running.');
});

test('an occupied explicit port is never stolen or stopped', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-pull-busy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const other = createServer((req, res) => res.end('unrelated'));
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => { other.close(); other.closeAllConnections(); });
  await assert.rejects(serve({ dir, port: other.address().port }), { code: 'EADDRINUSE' });
  assert.equal(await (await fetch(`http://127.0.0.1:${other.address().port}`)).text(), 'unrelated');
});

test('missing credentials produce actionable instructions without starting a server', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-pull-login-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(runCLI(['--no-open'], { dir, authenticate: () => { throw new Error('Run gh auth login'); } }), /gh auth login/);
  await assert.rejects(readFile(join(dir, 'instance.json')), { code: 'ENOENT' });
});


test('config paths accept relative paths, spaces and home expansion; reject missing values and control commands', () => {
  assert.equal(parseArgs(['--config', 'my views.json']).configPath, resolve('my views.json'));
  assert.equal(parseArgs(['--config', '~/views.json']).configPath, join(homedir(), 'views.json'));
  for (const args of [['--config'], ['--config', ''], ['--config', '--no-open'], ['status', '--config', 'views.json'], ['--config', 'views.json', 'stop']]) assert.throws(() => parseArgs(args));
});

test('custom config persists saved views and prevents switching a running dashboard to another file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-pull-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'new folder', 'custom views.json');
  const list = async () => ({}); list.viewer = async () => 'alice';
  const instance = await serve({ dir, port: 0, configPath }, { makeApp: options => createApp({ ...options, list }) });
  t.after(instance.stop);
  await assert.rejects(readFile(configPath), { code: 'ENOENT' });
  const origin = `http://127.0.0.1:${instance.port}`;
  const response = await fetch(`${origin}/api/saved-views`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ action: 'save', account: 'alice', name: 'Authored', query: 'author:@me' }) });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(await readFile(configPath)).accounts[0].views[1].name, 'Authored');
  const options = { dir, output() {}, authenticate() { throw new Error('Must reuse'); } };
  await runCLI(['--no-open', '--config', configPath], options);
  await runCLI(['--no-open'], options);
  await assert.rejects(runCLI(['--no-open', '--config', join(dir, 'other.json')], options), /gh pull stop/);
  await instance.stop();
  const restarted = await serve({ dir, port: 0, configPath }, { makeApp: options => createApp({ ...options, list }) });
  t.after(restarted.stop);
  assert.equal((await (await fetch(`http://127.0.0.1:${restarted.port}/api/saved-views`)).json()).views.find(view => view.name === 'Authored').query, 'author:@me');
});

test('invalid or unreadable config fails before starting a dashboard and preserves the file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-pull-invalid-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'views.json');
  for (const content of ['broken', '{}', 'null']) {
    await writeFile(configPath, content);
    let reason = 'Invalid saved views file';
    try { JSON.parse(content); } catch (error) { reason = error.message; }
    await assert.rejects(serve({ dir, port: 0, configPath }), { message: `Cannot read saved-views config ${configPath}: ${reason}` });
    assert.equal(await readFile(configPath, 'utf8'), content);
    await assert.rejects(readFile(join(dir, 'instance.json')), { code: 'ENOENT' });
  }
  await assert.rejects(serve({ dir, port: 0, configPath: dir }), /Cannot read saved-views config .*EISDIR/);
});
