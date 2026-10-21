import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { sessionRole } from '../../../lib/admin-auth';
import { readOrders, updateOrder } from '../../../lib/orders-store';
import { reverseInvoice, smartbillConfigured } from '../../../lib/smartbill';
import { mutateCatalog } from '../../../lib/catalog-store';
import { restockOrder } from '../../../lib/stock-ledger';
import { paymentStamp } from '../../../lib/stripe-report';

export const prerender = false;

const SECRET = import.meta.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// Retur / rambursare într-un singur pas:
//   1. rambursează plata prin Stripe (integral, sau parțial dacă se trimite `amount` în RON),
//   2. stornează factura SmartBill (best-effort — dacă eșuează, rambursarea rămâne făcută),
//   3. marchează comanda „Anulată" + salvează refundId / storno,
//   4. (opțional, `restock: true`) repune bucățile în stoc — doar produsele cu stoc
//      urmărit, o singură dată pe comandă (lib/stock-ledger.ts). Adminul alege:
//      da dacă coletul n-a plecat, nu până nu s-a verificat returul.
//
// Ordinea e intenționată: banii clientului sunt pasul critic, deci se fac primii. Storno
// e document fiscal și se emite după; dacă pică, se raportează clar și se poate storna manual.
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!sessionRole(cookies)) return json({ error: 'Neautorizat.' }, 401);
  if (!SECRET) return json({ error: 'Stripe nu e configurat (STRIPE_SECRET_KEY).' }, 503);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const id = String(body?.id ?? '').trim();
  if (!id) return json({ error: 'Lipsește id-ul comenzii.' }, 400);

  const order = (await readOrders()).find((o) => o.id === id);
  if (!order) return json({ error: 'Comandă inexistentă.' }, 404);
  if (order.refundId) return json({ error: `Comanda a fost deja rambursată (${order.refundId}).` }, 409);

  // Sumă opțională pentru rambursare parțială (RON). Fără ea = rambursare integrală.
  const partial = body?.amount !== undefined && body?.amount !== null && body?.amount !== '';
  const amountRon = partial ? Math.round(Number(body.amount)) : 0;
  if (partial && (!Number.isFinite(amountRon) || amountRon <= 0 || amountRon > order.amountTotal)) {
    return json({ error: `Sumă de rambursare invalidă (max ${order.amountTotal} RON).` }, 400);
  }

  const stripe = new Stripe(SECRET);

  // 1) Rambursare Stripe. Comanda are ca id chiar checkout session id-ul.
  let refundId = '';
  let refundAmount = 0;
  try {
    const session = await stripe.checkout.sessions.retrieve(id);
    const pi = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;
    if (!pi) return json({ error: 'Nu am găsit plata (payment_intent) pentru această comandă.' }, 422);

    const refund = await stripe.refunds.create(
      {
        payment_intent: pi,
        ...(partial ? { amount: amountRon * 100 } : {}),
        // Comanda + factura și pe rambursare (refund_metadata în raportul lunar).
        metadata: paymentStamp(order),
      },
      { idempotencyKey: `refund_${id}` },
    );
    refundId = refund.id;
    refundAmount = Math.round((Number(refund.amount) || 0) / 100);
  } catch (err: any) {
    return json({ error: err?.message || 'Rambursarea Stripe a eșuat.' }, 502);
  }

  // 2) Stornare factură SmartBill (best-effort — banii sunt deja rambursați).
  let stornoSeries: string | undefined;
  let stornoNumber: string | undefined;
  let stornoError: string | undefined;
  if (order.invoiceSeries && order.invoiceNumber) {
    if (smartbillConfigured()) {
      try {
        const st = await reverseInvoice(order.invoiceSeries, order.invoiceNumber);
        stornoSeries = st.series;
        stornoNumber = st.number;
      } catch (err: any) {
        stornoError = err?.message || 'Stornarea SmartBill a eșuat.';
      }
    } else {
      stornoError = 'SmartBill nu e configurat — stornează factura manual.';
    }
  }

  // 3) Persistă starea comenzii.
  try {
    let updated = await updateOrder(id, {
      status: 'cancelled',
      refundId,
      refundedAt: Date.now(),
      refundAmount,
      ...(stornoSeries !== undefined ? { stornoSeries } : {}),
      ...(stornoNumber !== undefined ? { stornoNumber } : {}),
    });

    // 4) Repune în stoc (dacă s-a cerut). Idempotent pe comandă.
    let restocked = false;
    let restockError: string | undefined;
    if (body?.restock === true && !order.restockedAt) {
      try {
        restocked = await mutateCatalog((products) => restockOrder(products, order.id, order.items));
        const stamped = await updateOrder(id, { restockedAt: Date.now() });
        if (stamped) updated = stamped;
      } catch (err: any) {
        restockError = err?.message || 'Repunerea în stoc a eșuat.';
      }
    }

    return json({ ok: true, refundId, refundAmount, storno: stornoNumber ? { series: stornoSeries, number: stornoNumber } : null, stornoError, restocked, restockError, order: updated || order });
  } catch (err: any) {
    // Banii sunt rambursați dar salvarea a eșuat — expune refundId ca să nu se piardă.
    return json({ error: `Rambursare făcută (${refundId}) dar salvarea comenzii a eșuat: ${err?.message || ''}`, refundId, stornoError }, 500);
  }
};
