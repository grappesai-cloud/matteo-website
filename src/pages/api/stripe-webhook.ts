import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { readCatalog, writeCatalog } from '../../lib/catalog-store';
import { addOrder, updateOrder } from '../../lib/orders-store';
import { orderFromStripeSession } from '../../lib/orders';
import { notifyRuvixNewOrder } from '../../lib/notify';
import { createAwb, fanConfigured } from '../../lib/fancourier';
import { issueInvoice, smartbillConfigured } from '../../lib/smartbill';
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
    const catalog = await readCatalog();

    // 1) Record the order (idempotent by session id) so admin & Ruvix can see it,
    //    and email Ruvix once on first insert.
    let recorded: Awaited<ReturnType<typeof addOrder>> | null = null;
    try {
      recorded = await addOrder(orderFromStripeSession(session, catalog));
      if (recorded.created) await notifyRuvixNewOrder(recorded.order, new URL(request.url).origin);
    } catch (err: any) {
      console.error('[webhook] order record failed:', err?.message);
    }

    // 1b) Auto-generate the FAN Courier AWB on first insert (best-effort).
    //     Guarded on `created` so duplicate webhook deliveries don't double-create
    //     a label, and on missing awb. On failure the order stays AWB-less and the
    //     admin "Generează AWB FAN" button is the fallback. Never blocks the 200.
    if (recorded?.created && fanConfigured() && !recorded.order.awb) {
      try {
        const { awb } = await createAwb(recorded.order);
        await updateOrder(recorded.order.id, { awb, courier: 'FAN Courier', status: 'shipped' });
      } catch (err: any) {
        console.error('[webhook] FAN AWB auto-generate failed:', err?.message);
      }
    }

    // 1c) Auto-issue the SmartBill fiscal invoice on first insert (best-effort).
    //     Guarded on `created` + missing invoice so duplicate deliveries don't
    //     double-bill. On failure the order stays invoice-less (re-issue manually
    //     in SmartBill). Never blocks the 200.
    if (recorded?.created && smartbillConfigured() && !recorded.order.invoiceNumber) {
      try {
        const { series, number } = await issueInvoice(recorded.order);
        await updateOrder(recorded.order.id, { invoiceSeries: series, invoiceNumber: number });
      } catch (err: any) {
        console.error('[webhook] SmartBill invoice failed:', err?.message);
      }
    }

    // 2) Decrement tracked stock.
    try {
      const cart: { s: string; c: string; z: SizeKey; q: number }[] = JSON.parse(
        session.metadata?.cart || '[]'
      );
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
