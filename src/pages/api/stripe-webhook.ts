import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { readCatalog, mutateCatalog } from '../../lib/catalog-store';
import { addOrder, updateOrder } from '../../lib/orders-store';
import { orderFromStripeSession } from '../../lib/orders';
import { notifyRuvixNewOrder, maybeNotifyShipped, maybeNotifyConfirmation } from '../../lib/notify';
import { createAwb, fanConfigured, placeCourierOrder, computePickupSlot } from '../../lib/fancourier';
import { readPickup, writePickup } from '../../lib/pickup-store';
import { issueInvoice, smartbillConfigured } from '../../lib/smartbill';
import { readPendingCheckout } from '../../lib/checkout-store';
import { promoLabelForSession } from '../../lib/promo';
import { consumeStock, releaseStock, sweepHolds } from '../../lib/stock-ledger';

export const prerender = false;

const SECRET = import.meta.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';
const WH_SECRET = import.meta.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || '';
// Optional TEST-mode webhook secret. When set, the endpoint also accepts Stripe
// test-mode events (so the full flow can be exercised with a 4242 card). Test
// events skip the real-world side effects (FAN label, SmartBill invoice).
const WH_SECRET_TEST = import.meta.env.STRIPE_WEBHOOK_SECRET_TEST || process.env.STRIPE_WEBHOOK_SECRET_TEST || '';

/** Cheia rezervării de stoc = tokenul nostru din metadata (sesiunile vechi: id-ul sesiunii). */
const stockKeyOf = (session: Stripe.Checkout.Session) => String(session.metadata?.pc || session.id);
function cartOf(session: Stripe.Checkout.Session): unknown {
  try { return JSON.parse(session.metadata?.cart || '[]'); } catch { return []; }
}

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
  // Stocul real se atinge doar la evenimente live; în dev (cheie de test) și la
  // evenimentele de test, ca să se poată testa tot lanțul cu cardul 4242.
  const touchStock = isLive || SECRET.startsWith('sk_test_');

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const catalog = await readCatalog();

    // 1) Record the order (idempotent by session id) so admin & Ruvix can see it,
    //    and email Ruvix once on first insert.
    // Our pre-Stripe checkout data (authoritative address + FAN-quoted shipping),
    // keyed by the token we put in the session metadata.
    const pending = await readPendingCheckout(String(session.metadata?.pc || '')).catch(() => null);
    const discountCode = (await promoLabelForSession(stripe, session)) || String(session.metadata?.promo || '');
    const override = {
      ...(pending ? { address: pending.address, customer: pending.customer, shippingAmount: pending.shippingAmount } : {}),
      ...(discountCode ? { discountCode } : {}),
    };

    let recorded: Awaited<ReturnType<typeof addOrder>> | null = null;
    try {
      recorded = await addOrder(orderFromStripeSession(session, catalog, override));
    } catch (err: any) {
      console.error('[webhook] order record failed:', err?.message);
    }

    // 2) Stocul, IMEDIAT după înregistrare (înaintea pașilor lenți: AWB, factură,
    //    emailuri), o singură dată per sesiune oricâte retrimiteri face Stripe:
    //    rezervarea din checkout devine definitivă; sesiunile fără rezervare
    //    (dinainte de registru) se scad acum. Tot în registru rămâne și
    //    rezervarea, deci un al doilea eveniment nu mai scade nimic.
    if (touchStock) {
      try {
        const key = stockKeyOf(session);
        const r = await mutateCatalog((products) => {
          sweepHolds(products);
          return consumeStock(products, key, cartOf(session));
        });
        if (recorded && !recorded.order.stockDecremented) {
          await updateOrder(recorded.order.id, { stockDecremented: true });
        }
        if (r.alreadyDone) console.log(`[webhook] stoc deja scăzut pentru ${key} (retrimitere Stripe)`);
      } catch (err: any) {
        console.error('[webhook] stock consume failed:', err?.message);
        // Acknowledge anyway — payment is valid; avoid Stripe retries hammering us.
      }
    }

    if (recorded?.created) {
      // Confirmarea către client pleacă prima (înainte de emailul de expediere).
      try { await maybeNotifyConfirmation(recorded.order); } catch (err: any) { console.error('[webhook] confirmation email failed:', err?.message); }
      try { await notifyRuvixNewOrder(recorded.order, new URL(request.url).origin); } catch (err: any) { console.error('[webhook] Ruvix email failed:', err?.message); }
    }

    // 3) Auto-generate the FAN Courier AWB on first insert → status „Trimisă",
    //    email the customer their tracking link, and schedule the courier pickup.
    //    Guarded on `created` (so duplicate webhook deliveries don't double-create a
    //    label) and on missing awb. On failure the order stays AWB-less and the admin
    //    „Generează AWB FAN" button is the fallback. Never blocks the 200.
    if (recorded?.created && !recorded.order.awb && (isLive ? fanConfigured() : true)) {
      try {
        // LIVE: real FAN AWB. TEST: dummy AWB so the chain (shipped + tracking email) runs.
        const awb = isLive
          ? (await createAwb(recorded.order)).awb
          : `TEST-${recorded.order.number}`;
        const shipped = await updateOrder(recorded.order.id, {
          awb,
          courier: isLive ? 'FAN Courier' : 'TEST (mod test)',
          status: 'shipped',
        });

        // 3a) Email the customer their tracking link (once, idempotent). Best-effort.
        try {
          if (shipped) await maybeNotifyShipped(shipped);
        } catch (err: any) {
          console.error('[webhook] customer tracking email failed:', err?.message);
        }

        // 3b) Auto-schedule the courier pickup — LIVE only. Debounced to ONE per day
        //     (one FAN courier order per branch covers all ready AWBs). Best-effort.
        if (isLive) {
          try {
            const slot = computePickupSlot();
            const last = await readPickup();
            if (last?.date !== slot.date) {
              const { orderId } = await placeCourierOrder({ ...recorded.order, awb });
              await writePickup({ date: slot.date, fanOrderId: orderId, orderNumber: recorded.order.number, at: Date.now() });
            }
          } catch (err: any) {
            console.error('[webhook] FAN pickup schedule failed:', err?.message);
          }
        }
      } catch (err: any) {
        console.error('[webhook] AWB auto-generate failed:', err?.message);
      }
    }

    // 4) Auto-issue the SmartBill fiscal invoice on first insert — LIVE only
    //    (a test order must NOT create a real fiscal document). Best-effort, dar
    //    motivul unui eșec se salvează pe comandă (admin: „factura nu s-a emis”).
    if (isLive && recorded?.created && smartbillConfigured() && !recorded.order.invoiceNumber) {
      try {
        const { series, number } = await issueInvoice(recorded.order);
        await updateOrder(recorded.order.id, { invoiceSeries: series, invoiceNumber: number, invoiceError: '' });
      } catch (err: any) {
        console.error('[webhook] SmartBill invoice failed:', err?.message);
        try { await updateOrder(recorded.order.id, { invoiceError: String(err?.message || 'Emiterea facturii a eșuat.') }); } catch {}
      }
    }
  }

  // Sesiune expirată (clientul n-a plătit în fereastra de 35 min): bucățile
  // rezervate la checkout revin în stoc. Evenimentul trebuie bifat în Stripe
  // Dashboard → Webhooks → endpoint → `checkout.session.expired`; dacă nu vine,
  // sweepHolds le eliberează oricum după 50 de minute.
  if (event.type === 'checkout.session.expired' && touchStock) {
    const session = event.data.object as Stripe.Checkout.Session;
    try {
      const key = stockKeyOf(session);
      const released = await mutateCatalog((products) => {
        sweepHolds(products);
        return releaseStock(products, key);
      });
      if (released) console.log(`[webhook] rezervare eliberată: ${key}`);
    } catch (err: any) {
      console.error('[webhook] stock release failed:', err?.message);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
