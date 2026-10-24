import { publicAssets } from '../public-assets.js';
import { build } from 'esbuild';
import { inject } from 'postject';
import { mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = join(root, '.build', 'extension');
const dist = join(root, 'dist');
await mkdir(work, { recursive: true });
await mkdir(dist, { recursive: true });
const version = process.env.GH_PULL_VERSION || `dev-${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()}`;
if (!/^[\w.+-]+$/.test(version)) throw new Error('Invalid GH_PULL_VERSION');
const main = join(work, 'main.cjs');
await build({
  entryPoints: [join(root, 'cli/main.js')], outfile: main, bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  define: { CLI_VERSION: JSON.stringify(version), 'import.meta.url': '__bundleMetaUrl' },
  banner: { js: "const __bundleMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
});
const assets = Object.fromEntries(publicAssets.map(([file]) => [`public/${file}`, join(root, 'public', file)]));
const notices = ['LICENSE', 'THIRD_PARTY_NOTICES', 'public/fonts/Inter-LICENSE.txt', 'public/vendor/codemirror.LICENSE.txt', 'public/vendor/svg.LICENSE.txt', 'public/vendor/lit-html.LICENSE.txt',
  'node_modules/proper-lockfile/LICENSE', 'node_modules/graceful-fs/LICENSE', 'node_modules/retry/License', 'node_modules/signal-exit/LICENSE.txt'];
let licenses = '';
for (const path of notices) licenses += `\n--- ${path} ---\n${await readFile(join(root, path), 'utf8')}\n`;
const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
if (!nodeLicense.ok) throw new Error(`Could not fetch Node.js license: HTTP ${nodeLicense.status}`);
licenses += `\n--- Node.js ${process.version} and bundled dependencies ---\n${await nodeLicense.text()}`;
const licensePath = join(work, 'LICENSES.txt');
await writeFile(licensePath, licenses);
assets['LICENSES.txt'] = licensePath;
const config = join(work, 'sea.json'), blob = join(work, 'sea.blob');
await writeFile(config, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
const os = process.platform === 'win32' ? 'windows' : process.platform;
const arch = process.arch === 'x64' ? 'amd64' : process.arch;
if (!['linux', 'darwin', 'windows'].includes(os) || !['amd64', 'arm64'].includes(arch)) throw new Error('Unsupported release platform');
const binary = resolve(dist, `gh-pull-${os}-${arch}${os === 'windows' ? '.exe' : ''}`);
await copyFile(process.execPath, binary);
await chmod(binary, 0o755);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', binary]);
await inject(binary, 'NODE_SEA_BLOB', await readFile(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', binary]);
console.log(binary);
