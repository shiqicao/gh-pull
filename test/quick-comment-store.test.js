import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSavedViewsStore } from '../saved-views.js';
import { insertPreset } from '../public/preset-model.js';

test('preset mutations preserve order, account isolation and saved views', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'quick-preset-test-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const path = join(dir, 'settings.json'), store = createSavedViewsStore(path);
  const views = await store.list('alex');
  const change = input => store.changeQuickComment('Alex', input);
  const [a] = await change({ action:'save', label:'Build', body:'[build]' });
  const [,b] = await change({ action:'save', label:'Lint', body:'[lint]', orgs:['orbit'] });
  await assert.rejects(change({ action:'save', label:'BUILD', body:'x' }), /already exists/);
  await assert.rejects(change({ action:'save', label:'Bad', body:'x', repos:['orbit'] }), /owner\/name/);
  await assert.rejects(change({ action:'save', label:'Bad', body:'x', orgs:[] }), /Every repository/);
  await change({ action:'move', id:b.id, delta:-1 });
  await change({ action:'delete', id:b.id });
  await change({ action:'restore', position:0, ...b });
  assert.deepEqual(await createSavedViewsStore(path).quickComments('alex'), JSON.parse(JSON.stringify([b,a])));
  assert.deepEqual(await store.quickComments('sam'), []);
  assert.deepEqual(await store.list('Alex'), views);
});
test('insert preserves existing content and never repeats a preset body', () => {
  assert.equal(insertPreset('  ', '[build]'), '[build]');
  assert.equal(insertPreset('  Hello  \n', '[build]'), '  Hello\n[build]');
  assert.equal(insertPreset('Hello [build]!', '[build]'), 'Hello [build]!');
});
