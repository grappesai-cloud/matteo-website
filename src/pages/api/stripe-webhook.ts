import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { readCatalog, writeCatalog } from '../../lib/catalog-store';
import type { SizeKey } from '../../lib/products';

export const prerender = false;

const SECRET = import.meta.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';
const WH_SECRET = import.meta.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || '';

export const POST: APIRoute = async ({ request }) => {
  if (!SECRET || !WH_SECRET) {
    return new Response('Webhook not configured', { status: 503 });
  }
  const sig = request.headers.get('stripe-signature');
  if (!sig) return new Response('Missing signature', { status: 400 });

  const stripe = new Stripe(SECRET);
  const raw = await request.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, WH_SECRET);
  } catch (err: any) {
    console.error('[webhook] signature verification failed:', err?.message);
    return new Response(`Webhook Error: ${err?.message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    try {
      const cart: { s: string; c: string; z: SizeKey; q: number }[] = JSON.parse(
        session.metadata?.cart || '[]'
      );
      const catalog = await readCatalog();
      let changed = false;
      for (const item of cart) {
        const p = catalog.find((x) => x.slug === item.s);
        if (!p || !p.trackStock) continue;
        const color = p.colors.find((c) => c.key === item.c) ?? p.colors[0];
        if (!color) continue;
        color.stock = color.stock || {};
        const cur = color.stock[item.z] ?? 0;
        color.stock[item.z] = Math.max(0, cur - (Number(item.q) || 1));
        changed = true;
      }
      if (changed) await writeCatalog(catalog);
    } catch (err: any) {
      console.error('[webhook] stock decrement failed:', err?.message);
      // Acknowledge anyway — payment is valid; avoid Stripe retries hammering us.
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
