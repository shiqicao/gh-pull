import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { ApiError } from './github.js';

export function createMarketplaceWebhook({ secret, cancel, now = Date.now }) {
  const deliveries = new Map();
  return async req => {
    if (req.method !== 'POST') throw new ApiError('Method not allowed.', 405);
    if (!secret) throw new ApiError('Marketplace webhook is not configured.', 503);
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ApiError('Expected application/json.', 415);
    const signature = req.headers['x-hub-signature-256'];
    if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) throw new ApiError('Invalid webhook signature.', 401);
    const delivery = req.headers['x-github-delivery'];
    if (typeof delivery !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(delivery)) throw new ApiError('Missing or invalid delivery ID.', 400);
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new ApiError('Webhook payload is too large.', 413);
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    const expected = createHmac('sha256', secret).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) throw new ApiError('Invalid webhook signature.', 401);
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch { throw new ApiError('Invalid JSON payload.', 400); }
    const event = req.headers['x-github-event'];
    if (event === 'ping') return { ok: true, event: 'ping' };
    if (event !== 'marketplace_purchase') return { ok: true, ignored: true };
    if (!payload || !['purchased', 'cancelled'].includes(payload.action)) throw new ApiError('Only free-plan purchases and cancellations are supported.', 422);
    const purchase = payload.marketplace_purchase;
    if (purchase?.plan?.price_model !== 'FREE') throw new ApiError('Only free Marketplace plans are supported.', 422);
    const account = purchase.account;
    if (!Number.isSafeInteger(account?.id) || account.id <= 0 || !/^[a-z0-9_-]+$/i.test(account?.login ?? '') || !['User', 'Organization'].includes(account?.type)) {
      throw new ApiError('Invalid Marketplace account.', 400);
    }
    const effective = Date.parse(payload.effective_date);
    if (!Number.isFinite(effective) || effective > now() + 60_000) throw new ApiError('Missing or future effective date.', 422);
    // Retain only delivery identifiers and hashes, never webhook bodies.
    for (const [id, entry] of deliveries) if (entry.expires <= now()) deliveries.delete(id);
    const digest = createHash('sha256').update(raw).digest('hex');
    const prior = deliveries.get(delivery);
    if (prior) {
      if (prior.digest !== digest) throw new ApiError('Delivery ID was reused with different data.', 409);
      await prior.result;
      return { ok: true, duplicate: true };
    }
    if (deliveries.size >= 1000) throw new ApiError('Webhook processing capacity reached. Retry later.', 503);
    const result = Promise.resolve().then(async () => {
      if (payload.action === 'cancelled') await cancel(account);
      // Free purchases need no billing record or extra entitlement: users complete
      // installation and OAuth sign-in to obtain the normal free dashboard access.
    });
    deliveries.set(delivery, { digest, result, expires: now() + 24 * 60 * 60 * 1000 });
    try { await result; }
    catch (error) { deliveries.delete(delivery); throw error; }
    return { ok: true, action: payload.action };
  };
}
