import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { readCatalog, writeCatalog } from '../../lib/catalog-store';
import { addOrder, updateOrder } from '../../lib/orders-store';
import { orderFromStripeSession } from '../../lib/orders';
import { notifyRuvixNewOrder, maybeNotifyShipped } from '../../lib/notify';
import { createAwb, fanConfigured, placeCourierOrder, computePickupSlot } from '../../lib/fancourier';
import { readPickup, writePickup } from '../../lib/pickup-store';
import { issueInvoice, smartbillConfigured } from '../../lib/smartbill';
import type { SizeKey } from '../../lib/products';

export const prerender = false;

const SECRET = import.meta.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';
const WH_SECRET = import.meta.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || '';
// Optional TEST-mode webhook secret. When set, the endpoint also accepts Stripe
// test-mode events (so the full flow can be exercised with a 4242 card). Test
// events skip the real-world side effects (FAN label, SmartBill invoice).
const WH_SECRET_TEST = import.meta.env.STRIPE_WEBHOOK_SECRET_TEST || process.env.STRIPE_WEBHOOK_SECRET_TEST || '';

export const POST: APIRoute = async ({ request }) => {
  if (!SECRET || !WH_SECRET) {
    return new Response('Webhook not configured', { status: 503 });
  }
  const sig = request.headers.get('stripe-signature');
  if (!sig) return new Response('Missing signature', { status: 400 });

  const stripe = new Stripe(SECRET);
  const raw = await request.text();

  // Verify against the live secret first, then the test secret (if configured).
  let event: Stripe.Event | null = null;
  for (const secret of [WH_SECRET, WH_SECRET_TEST].filter(Boolean)) {
    try {
      event = await stripe.webhooks.constructEventAsync(raw, sig, secret);
      break;
    } catch { /* try next secret */ }
  }
  if (!event) {
    console.error('[webhook] signature verification failed for all configured secrets');
    return new Response('Webhook Error: signature mismatch', { status: 400 });
  }

  // Live events create real artifacts (courier label, fiscal invoice). Test-mode
  // events (livemode=false) run the safe chain only.
  const isLive = event.livemode === true;

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
    if (recorded?.created && !recorded.order.awb && (isLive ? fanConfigured() : true)) {
      try {
        // LIVE: generate a real FAN AWB. TEST: use a dummy AWB so the rest of the
        // chain (status→shipped + customer tracking email) runs without a real label.
        const awb = isLive
          ? (await createAwb(recorded.order)).awb
          : `TEST-${recorded.order.number}`;
        const shipped = await updateOrder(recorded.order.id, {
          awb,
          courier: isLive ? 'FAN Courier' : 'TEST (mod test)',
          status: 'shipped',
        });

        // 1b-1) Email the customer their tracking link (once, idempotent). Best-effort.
        try {
          if (shipped) await maybeNotifyShipped(shipped);
        } catch (err: any) {
          console.error('[webhook] customer tracking email failed:', err?.message);
        }

        // 1b-2) Auto-schedule the courier pickup — LIVE only. Debounced to ONE per
        //       day (FAN: a single courier order per branch covers all ready AWBs).
        //       Best-effort; failure leaves the AWB ready for a portal pickup.
        if (isLive) {
          try {
            const slot = computePickupSlot();
            const last = await readPickup();
            if (last?.date !== slot.date) {
              const { orderId } = await placeCourierOrder({ ...recorded.order, awb });
              await writePickup({ date: slot.date, fanOrderId: orderId, orderNumber: recorded.order.number, at: Date.now() });
              console.log('[webhook] FAN pickup scheduled for', slot.date, 'order', orderId);
            } else {
              console.log('[webhook] FAN pickup already scheduled for', slot.date, '— skipping');
            }
          } catch (err: any) {
            console.error('[webhook] FAN pickup schedule failed:', err?.message);
          }
        }
      } catch (err: any) {
        console.error('[webhook] AWB auto-generate failed:', err?.message);
      }
    }

    // 1c) Auto-issue the SmartBill fiscal invoice on first insert — LIVE only
    //     (a test order must NOT create a real fiscal document). Best-effort.
    if (isLive && recorded?.created && smartbillConfigured() && !recorded.order.invoiceNumber) {
      try {
        const { series, number } = await issueInvoice(recorded.order);
        await updateOrder(recorded.order.id, { invoiceSeries: series, invoiceNumber: number });
      } catch (err: any) {
        console.error('[webhook] SmartBill invoice failed:', err?.message);
      }
    }

    // 2) Decrement tracked stock — LIVE only (a test order must not touch inventory).
    if (isLive) try {
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
