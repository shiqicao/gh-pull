import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoClient } from '../public/demo.js';

test('demo supplies fictional PRs, branches, reviewers and all four PR statuses', async () => {
  const demo = createDemoClient(Date.parse('2026-10-08T12:00:00Z'));
  const data = await (await demo.request('/api/pulls?scope=involved&state=all')).json();
  assert.equal(data.items.length, 7);
  assert.equal(new Set(data.items.map(pr => pr.repo)).size, 3);
  assert.deepEqual(new Set(data.items.map(pr => pr.status)), new Set(['OPEN', 'DRAFT', 'MERGED', 'CLOSED']));
  assert.ok(data.items.every(pr => pr.id.startsWith('demo-') && pr.branch));
  assert.equal(data.items[0].updatedAt, '2026-10-08T11:48:00.000Z');
  assert.equal(Object.keys(demo.initialViewed).length, 2);
});

test('demo scope and state filters work', async () => {
  const demo = createDemoClient();
  const authored = await (await demo.request('/api/pulls?scope=authored&state=all')).json();
  assert.equal(authored.items.length, 2);
  assert.ok(authored.items.every(pr => pr.author === authored.viewer));
  const review = await (await demo.request('/api/pulls?scope=review&state=open')).json();
  assert.equal(review.items.length, 1);
  assert.equal(review.items[0].number, 183);
  const merged = await (await demo.request('/api/pulls?state=merged')).json();
  assert.equal(merged.items.length, 1);
});

test('demo edits and status changes stay in the mock client and reset in a fresh client', async () => {
  const demo = createDemoClient();
  const data = await (await demo.request('/api/pulls?scope=authored')).json();
  const pr = data.items[0];
  const edit = await demo.request('/api/pulls/title', { method: 'PATCH', body: JSON.stringify({ id: pr.id, title: 'Sample edited title', expectedTitle: pr.title }) });
  assert.equal((await edit.json()).title, 'Sample edited title');
  const draft = await demo.request('/api/pulls/draft', { method: 'PATCH', body: JSON.stringify({ id: pr.id }) });
  assert.equal((await draft.json()).status, 'DRAFT');
  const ready = await demo.request('/api/pulls/ready', { method: 'PATCH', body: JSON.stringify({ id: pr.id }) });
  assert.equal((await ready.json()).status, 'OPEN');
  const fresh = await (await createDemoClient().request('/api/pulls?scope=authored')).json();
  assert.equal(fresh.items[0].title, pr.title);
  const denied = await demo.request('/api/pulls/draft', { method: 'PATCH', body: JSON.stringify({ id: 'demo-web-245' }) });
  assert.equal(denied.status, 403);
});
