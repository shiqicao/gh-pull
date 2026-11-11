import { spawn, execFile } from 'node:child_process';
import { mkdir, chmod, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { isSea, getAsset } from 'node:sea';
import lockfile from 'proper-lockfile';
import { createApp } from '../server.js';
import { defaultToken } from '../github-client.js';
import { createSavedViewsStore, defaultSavedViewsPath } from '../saved-views.js';

const exec = promisify(execFile);
export const VERSION = typeof CLI_VERSION === 'string' ? CLI_VERSION : 'development';
export const HELP = `Usage: gh pull [--no-open] [--port PORT] [--foreground] [--config PATH]
       gh pull status
       gh pull stop

Open your pull request dashboard using your existing GitHub CLI login.
The dashboard runs in the background on 127.0.0.1. Run again to reopen it.

  --no-open       Print the URL without opening a browser
  --port PORT     Listen on a specific port (default: 3000, or an available port)
  --config PATH   Use a saved-views JSON file (default: XDG config directory)
  --foreground    Keep the server in this terminal; Ctrl+C stops it
  --licenses      Show bundled open-source licenses
  --version       Show the installed version
  --help          Show this help

First-time setup: gh auth login --hostname github.com
After upgrading or switching accounts: gh pull stop, then gh pull
`;

export function parseArgs(args) {
  const options = { command: 'start', open: true, foreground: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { command: 'help' };
    if (arg === '--licenses') return { command: 'licenses' };
    if (arg === '--version' || arg === '-v') return { command: 'version' };
    if (arg === '--no-open') options.open = false;
    else if (arg === '--foreground') options.foreground = true;
    else if (arg === '--config') {
      const path = args[++i];
      if (!path || path.startsWith('-')) throw new Error('--config requires a file path.');
      options.configPath = resolve(path === '~' ? homedir() : path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path);
    } else if (arg === '--port') {
      const port = args[++i];
      if (!/^\d+$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535) throw new Error('--port must be between 1 and 65535.');
      options.port = Number(port);
    } else if (['status', 'stop'].includes(arg) && options.command === 'start') options.command = arg;
    else throw new Error(`Unknown argument: ${arg}. Run gh pull --help.`);
  }
  if (options.command !== 'start' && (options.port || options.configPath || options.foreground || !options.open)) throw new Error('Start options cannot be used with status or stop.');
  return options;
}

export function stateDirectory(env = process.env, platform = process.platform) {
  if (env.GH_PULL_STATE_DIR) return resolve(env.GH_PULL_STATE_DIR);
  const base = platform === 'win32' ? (env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'))
    : platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : (env.XDG_STATE_HOME || join(homedir(), '.local', 'state'));
  return join(base, 'gh-pull');
}

async function readState(dir) {
  try {
    const state = JSON.parse(await readFile(join(dir, 'instance.json'), 'utf8'));
    if (Number.isInteger(state.port) && state.port > 0 && state.port <= 65535 && /^[a-f0-9]{64}$/.test(state.token)) return state;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  return null;
}

async function control(state, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${state.port}/api/cli`, {
    method, headers: { Authorization: `Bearer ${state.token}` }, redirect: 'error', signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error('The saved dashboard instance did not respond.');
  const result = await response.json();
  if (result.app !== 'gh-pull') throw new Error('The saved port is being used by another application.');
  return result;
}

async function running(dir) {
  const state = await readState(dir);
  if (!state) return null;
  try { return { ...state, ...await control(state) }; } catch { return null; }
}

export async function openBrowser(url, platform = process.platform) {
  // The URL is generated from a loopback address and numeric port, never shell input.
  if (platform === 'darwin') await exec('open', [url], { timeout: 5000 });
  else if (platform === 'win32') await exec('rundll32.exe', ['url.dll,FileProtocolHandler', url], { timeout: 5000 });
  else await exec('xdg-open', [url], { timeout: 5000 });
}

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const failed = error => { app.off('listening', ready); reject(error); };
    const ready = () => { app.off('error', failed); resolve(); };
    app.once('error', failed); app.once('listening', ready); app.listen(port, '127.0.0.1');
  });
}

export async function serve({ dir, port, configPath = defaultSavedViewsPath(), token = randomBytes(32).toString('hex') }, { makeApp = createApp } = {}) {
  let closing;
  const stop = () => closing ??= (async () => {
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
    const state = await readState(dir);
    if (state?.token === token) await rm(join(dir, 'instance.json'), { force: true });
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  })();
  configPath = resolve(configPath);
  const savedViews = createSavedViewsStore(configPath);
  try { await savedViews.list(''); }
  catch (error) { throw new Error(`Cannot read saved-views config ${configPath}: ${error.cause?.message ?? error.message}`, { cause: error }); }
  const app = makeApp({ savedViews, config: { mode: 'local' }, localControl: { token, version: VERSION, stop } });
  try {
    try { await listen(app, port ?? 3000); }
    catch (error) {
      if (error.code !== 'EADDRINUSE' || port !== undefined) throw error;
      await listen(app, 0);
    }
    const state = { port: app.address().port, token, pid: process.pid, configPath };
    const temp = join(dir, `instance-${token}.tmp`);
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, join(dir, 'instance.json'));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return { ...state, version: VERSION, stop, app };
  } catch (error) { app.close(); app.closeAllConnections(); throw error; }
}

async function launchDaemon(options) {
  const args = isSea() ? ['--serve'] : [fileURLToPath(new URL('./main.js', import.meta.url)), '--serve'];
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('Dashboard startup timed out. Try gh pull --foreground.')), 15_000);
    function fail(error) { clearTimeout(timer); child.kill(); reject(error); }
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`Dashboard exited during startup (${code}). Try gh pull --foreground.`)));
    child.once('message', message => {
      if (message.error) return fail(new Error(message.error));
      clearTimeout(timer); child.removeAllListeners('exit'); child.removeAllListeners('error');
      child.disconnect(); child.unref(); resolve(message);
    });
    child.send(options);
  });
}

export async function runCLI(args, { dir = stateDirectory(), authenticate = defaultToken, open = openBrowser, output = console.log } = {}) {
  const options = parseArgs(args);
  if (options.command === 'help') return output(HELP);
  if (options.command === 'licenses') return output(isSea() ? getAsset('LICENSES.txt', 'utf8') : await readFile(new URL('../THIRD_PARTY_NOTICES', import.meta.url), 'utf8'));
  if (options.command === 'version') return output(`gh-pull ${VERSION}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  const release = await lockfile.lock(dir, { lockfilePath: join(dir, 'launch.lock'), stale: 30_000, retries: { retries: 40, minTimeout: 250, maxTimeout: 250 } })
    .catch(error => { if (error.code === 'ELOCKED') throw new Error('Another gh pull command is starting. Wait a moment and retry.'); throw error; });
  let instance;
  try {
    instance = await running(dir);
    if (options.command === 'status') return output(instance ? `gh-pull ${instance.version} is running at http://127.0.0.1:${instance.port}` : 'gh-pull is not running.');
    if (options.command === 'stop') {
      if (instance) {
        await control(instance, 'POST');
        // Wait for shutdown before another launch can acquire the lock.
        for (let i = 0; i < 50; i++) {
          if (!await running(dir)) break;
          await new Promise(resolve => setTimeout(resolve, 100));
          if (i === 49) throw new Error('Dashboard is still stopping. Retry gh pull status.');
        }
      }
      return output(instance ? 'gh-pull stopped.' : 'gh-pull is not running.');
    }
    if (instance && options.port && options.port !== instance.port) throw new Error(`Already running on port ${instance.port}. Run gh pull stop before changing the port.`);
    if (instance && options.configPath && options.configPath !== instance.configPath) throw new Error('Already running with a different or unknown config file. Run gh pull stop before changing --config.');
    if (!instance) {
      await authenticate();
      instance = options.foreground ? await serve({ dir, port: options.port, configPath: options.configPath }) : await launchDaemon({ dir, port: options.port, configPath: options.configPath });
    } else output('Reusing the running dashboard.');
  } finally { await release(); }
  const url = `http://127.0.0.1:${instance.port}`;
  output(`gh-pull → ${url}`);
  output(options.foreground && instance.stop ? 'Press Ctrl+C to stop.' : 'Stop with: gh pull stop');
  if (options.open) {
    try { await open(url); } catch { output('Could not open a browser automatically. Open the URL above.'); }
  }
  return instance;
}
