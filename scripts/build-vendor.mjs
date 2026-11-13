import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

// The checked-in bundle keeps the runtime build independent of devDependencies.
const result = await build({
  entryPoints: ['scripts/vendor/codemirror.js'], outfile: 'public/vendor/codemirror.js',
  bundle: true, minify: true, format: 'esm', target: ['es2022'],
  metafile: true,
  legalComments: 'external',
});
const packages = [...new Set(Object.keys(result.metafile.inputs).filter(path => path.startsWith('node_modules/'))
  .map(path => path.split('/').slice(0, path.startsWith('node_modules/@') ? 3 : 2).join('/')))];
const licenses = await Promise.all(packages.sort().map(async path => `${path.slice(13)}\n\n${await readFile(`${path}/LICENSE`, 'utf8')}`));
await writeFile('public/vendor/codemirror.LICENSE.txt', licenses.join('\n\n---\n\n'));

await build({
  entryPoints: ['scripts/vendor/svg.js'], outfile: 'public/vendor/svg.js',
  bundle: true, minify: true, format: 'esm', target: ['es2022'], legalComments: 'external',
});
await writeFile('public/vendor/svg.LICENSE.txt', await readFile('node_modules/@svgdotjs/svg.js/LICENSE.txt', 'utf8'));

await build({
  entryPoints: ['scripts/vendor/lit-html.js'], outfile: 'public/vendor/lit-html.js',
  bundle: true, minify: true, format: 'esm', target: ['es2022'], legalComments: 'external',
});
await writeFile('public/vendor/lit-html.LICENSE.txt', await readFile('node_modules/lit-html/LICENSE', 'utf8'));

// The upstream polyfill creates two style elements. Authorize them with the
// same per-response nonce as CodeMirror, without weakening the app's CSP.
const interestSource = await readFile('node_modules/interestfor/src/interestfor.js', 'utf8');
let noncePatches = 0;
const interestWithNonce = interestSource.replace(/const (style|uaStyle) = document\.createElement\("style"\);/g, (line, name) => {
  noncePatches++;
  return `${line}\n${name}.nonce = document.querySelector('meta[name="style-nonce"]')?.content ?? '';`;
});
if (noncePatches !== 2) throw new Error('Review interestfor style nonce integration after upgrade');
await build({
  stdin: { contents: interestWithNonce, sourcefile: 'interestfor.js' }, outfile: 'public/vendor/interestfor.js',
  bundle: true, minify: true, format: 'esm', target: ['es2022'], legalComments: 'external',
});
await writeFile('public/vendor/interestfor.LICENSE.txt', await readFile('node_modules/interestfor/LICENSE', 'utf8'));
