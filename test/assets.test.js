import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { publicAssets } from '../public-assets.js';

test('shared asset list covers every packaged public file without duplicates', async () => {
  async function files(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory()
      ? files(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`)
      : `${prefix}${entry.name}`))).flat();
  }
  assert.deepEqual(publicAssets.map(([file]) => file).sort(), (await files(new URL('../public/', import.meta.url))).sort());
});
