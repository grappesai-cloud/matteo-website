import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { readCatalog, writeCatalog } from '../../lib/catalog-store';
import { addOrder, updateOrder } from '../../lib/orders-store';
import { orderFromStripeSession } from '../../lib/orders';
import { notifyRuvixNewOrder } from '../../lib/notify';
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

    // NOTE: comanda rămâne pe status „Nouă" la plată — NU se mai generează AWB și NU
    // se mai trece automat pe „Trimisă". Fluxul e acum manual și legat de AWB:
    //   Nouă → (Ruvix) În producție → Generează AWB ⇒ Trimisă → Livrată / Anulată.
    // Generarea AWB (butonul „Generează AWB FAN" / POST /api/admin/fan-awb) e cea care
    // trece comanda pe „Trimisă", trimite emailul de tracking și programează ridicarea.

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
