import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const directory of ['.', 'cli', 'public', 'scripts', 'test']) {
  const root = new URL(`../${directory}/`, import.meta.url);
  for (const file of (await readdir(root, { recursive: directory !== '.' })).sort()) {
    if (/\.(?:js|mjs)$/.test(file)) execFileSync(process.execPath, ['--check', fileURLToPath(new URL(file, root))], { stdio: 'inherit' });
  }
}
