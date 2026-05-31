import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { readCatalog } from '../../lib/catalog-store';
import { addOrder } from '../../lib/orders-store';
import { orderFromStripeSession } from '../../lib/orders';
import { notifyRuvixNewOrder } from '../../lib/notify';

// Idempotent fallback: the success page pings this so an order is recorded even
// if the Stripe webhook is delayed or not configured. Safe because we verify the
// session is genuinely paid via the Stripe API before persisting anything.
export const prerender = false;

const SECRET = import.meta.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

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

    const catalog = await readCatalog();
    const { order, created } = await addOrder(orderFromStripeSession(session, catalog));
    if (created) await notifyRuvixNewOrder(order, url.origin);
    return json({ ok: true, number: order.number });
  } catch (err: any) {
    console.error('[order-from-session] failed:', err?.message);
    return json({ ok: false }, 500);
  }
};
