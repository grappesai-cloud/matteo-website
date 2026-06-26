import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { readCatalog } from '../../lib/catalog-store';
import { addOrder, readOrders } from '../../lib/orders-store';
import { orderFromStripeSession } from '../../lib/orders';
import { notifyRuvixNewOrder } from '../../lib/notify';

// Idempotent fallback: the success page pings this so an order is recorded even
// if the Stripe webhook is delayed or not configured. Safe because we verify the
// session is genuinely paid via the Stripe API before persisting anything.
//
// IMPORTANT — race avoidance: the webhook is the PRIMARY recorder (it also writes
// the AWB + invoice back into the same Blob JSON). If this fallback wrote the order
// concurrently, a late write here could clobber the webhook's awb/invoice writeback
// (last-writer-wins on the single JSON). So we first POLL for the webhook's record
// and only write as a genuine fallback when the webhook truly hasn't landed.
export const prerender = false;

const SECRET = import.meta.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const GET: APIRoute = async ({ url }) => {
  if (!SECRET || SECRET.startsWith('sk_test_xxx')) return json({ ok: false }, 503);
  const sessionId = url.searchParams.get('session_id') || '';
  if (!sessionId.startsWith('cs_')) return json({ ok: false }, 400);

  try {
    const stripe = new Stripe(SECRET);
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['total_details'],
    });
    if (session.payment_status !== 'paid') return json({ ok: false, pending: true });

    // Give the webhook a head start: poll for its record (so it stays the sole
    // writer and its AWB/invoice writeback isn't clobbered). ~8s total.
    for (let i = 0; i < 6; i++) {
      const existing = (await readOrders()).find((o) => o.id === sessionId);
      if (existing) return json({ ok: true, number: existing.number });
      await sleep(1300);
    }

    // Webhook hasn't recorded it after polling — record now as a real fallback.
    const catalog = await readCatalog();
    const { order, created } = await addOrder(orderFromStripeSession(session, catalog));
    if (created) await notifyRuvixNewOrder(order, url.origin);
    return json({ ok: true, number: order.number });
  } catch (err: any) {
    console.error('[order-from-session] failed:', err?.message);
    return json({ ok: false }, 500);
  }
};
