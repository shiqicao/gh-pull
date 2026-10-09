import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { request } from 'node:http';
import { createMarketplaceWebhook } from '../marketplace.js';
import { createApp } from '../server.js';

const secret = 'test-webhook-secret';
const payload = { action: 'purchased', effective_date: '2026-01-01T00:00:00Z', marketplace_purchase: { account: { id: 1, login: 'alice', type: 'User' }, plan: { price_model: 'FREE' } } };
function delivery(body = JSON.stringify(payload), overrides = {}) {
  const req = Readable.from([Buffer.from(body)]);req.method = 'POST';
  req.headers = { 'content-type': 'application/json', 'x-github-event': 'marketplace_purchase', 'x-github-delivery': 'delivery-1', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'), ...overrides };
  return req;
}

test('Marketplace accepts signed ping and free purchase without invoking cancellation', async () => {
  let cancellations = 0;
  const handle = createMarketplaceWebhook({ secret, cancel: async () => { cancellations++; } });
  assert.deepEqual(await handle(delivery('{}', { 'x-github-event': 'ping' })), { ok: true, event: 'ping' });
  assert.equal((await handle(delivery())).action, 'purchased');
  assert.equal((await handle(delivery())).duplicate, true);
  assert.equal(cancellations, 0);
});

test('Marketplace authenticates exact raw bytes before JSON parsing or cancellation', async () => {
  const handle = createMarketplaceWebhook({ secret, cancel: async () => assert.fail('must not cancel') });
  for (const signature of [undefined, 'sha1=abc', 'sha256=abc', 'sha256=' + '0'.repeat(64)]) {
    await assert.rejects(handle(delivery('{broken', { 'x-hub-signature-256': signature })), { status: 401 });
  }
  const original = delivery();
  await assert.rejects(handle(delivery(JSON.stringify(payload) + ' ', { 'x-hub-signature-256': original.headers['x-hub-signature-256'] })), { status: 401 });
  await assert.rejects(handle(delivery('{broken')), { status: 400 });
});

test('Marketplace validates payload limits, method, format, configuration and free-plan schema', async () => {
  const handle = createMarketplaceWebhook({ secret, cancel: async () => {} });
  await assert.rejects(createMarketplaceWebhook({ cancel: async () => {} })(delivery()), { status: 503 });
  const get = delivery();get.method = 'GET';await assert.rejects(handle(get), { status: 405 });
  await assert.rejects(handle(delivery('{}', { 'content-type': 'application/x-www-form-urlencoded' })), { status: 415 });
  await assert.rejects(handle(delivery('x'.repeat(1024 * 1024 + 1))), { status: 413 });
  await assert.rejects(handle(delivery('{}', { 'x-github-delivery': undefined })), { status: 400 });
  for (const data of [null, {}, { ...payload, action: 'changed' }, { ...payload, effective_date: 'invalid' }, { ...payload, effective_date: '2999-01-01' }, { ...payload, marketplace_purchase: { ...payload.marketplace_purchase, plan: { price_model: 'FLAT_RATE' } } }]) {
    await assert.rejects(handle(delivery(JSON.stringify(data))), { status: 422 });
  }
  await assert.rejects(handle(delivery(JSON.stringify({ ...payload, marketplace_purchase: { ...payload.marketplace_purchase, account: { id: 'bad' } } }))), { status: 400 });
});

test('cancellation duplicates share processing, failed cleanup can be retried, changed payloads cannot reuse IDs', async () => {
  let calls = 0, fail = true;
  const handle = createMarketplaceWebhook({ secret, cancel: async account => { calls++;assert.equal(account.id, 1);if (fail) throw new Error('retry'); } });
  const raw = JSON.stringify({ ...payload, action: 'cancelled' });
  await assert.rejects(handle(delivery(raw)), /retry/);
  fail = false;
  const results = await Promise.all([handle(delivery(raw)), handle(delivery(raw))]);
  assert.equal(calls, 2);assert.equal(results.filter(result => result.duplicate).length, 1);
  await assert.rejects(handle(delivery()), { status: 409 });
});

test('webhook HTTP route accepts signed requests without cookies and keeps browser API origin protection', async t => {
  const config = { mode: 'github-app', origin: 'https://dashboard.example', clientId: 'id', clientSecret: 'secret', marketplaceWebhookSecret: secret };
  const app = createApp({ config });await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve);app.closeAllConnections(); }));
  const body = JSON.stringify(payload), headers = delivery(body).headers;
  const call = (path, extra = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: app.address().port, path, method: 'POST', headers: { host: 'dashboard.example', ...headers, ...extra } }, res => {
      let text = '';res.on('data', chunk => { text += chunk; });res.on('end', () => resolve({ status: res.statusCode, text }));
    });req.on('error', reject);req.end(body);
  });
  assert.equal((await call('/webhooks/marketplace', { origin: 'https://github.com', 'sec-fetch-site': 'cross-site' })).status, 200);
  assert.equal((await call('/api/pulls', { origin: 'https://github.com' })).status, 403);
  assert.equal((await call('/webhooks/marketplace', { host: 'evil.example' })).status, 403);
  assert.equal((await call('/webhooks/marketplace', { 'x-hub-signature-256': 'bad' })).status, 401);
});
