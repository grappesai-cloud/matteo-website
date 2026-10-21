import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { isAdmin } from '../../../lib/admin-auth';
import { readOrders, updateOrder } from '../../../lib/orders-store';
import { issueInvoice, smartbillConfigured } from '../../../lib/smartbill';
import { stampPayment } from '../../../lib/stripe-report';

export const prerender = false;

const SECRET = import.meta.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// Emite (din nou) factura SmartBill pentru o comandă rămasă fără factură: webhook-ul
// o emite automat la plată, dar dacă a picat (SmartBill indisponibil, total care nu
// bate cu plata) comanda rămâne cu `invoiceError` și adminul apasă „Emite factura”.
// Verificarea totalului (factură = plata Stripe) se face și aici, în issueInvoice.
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies)) return json({ error: 'Neautorizat.' }, 401);
  if (!smartbillConfigured()) return json({ error: 'SmartBill nu e configurat.' }, 503);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const id = String(body?.id ?? '').trim();
  if (!id) return json({ error: 'Lipsește id-ul comenzii.' }, 400);

  const order = (await readOrders()).find((o) => o.id === id);
  if (!order) return json({ error: 'Comandă inexistentă.' }, 404);
  if (order.invoiceNumber) return json({ error: `Comanda are deja factura ${order.invoiceSeries || ''}-${order.invoiceNumber}.` }, 409);
  if (order.refundId) return json({ error: 'Comanda e rambursată; nu se mai emite factură.' }, 409);

  try {
    const { series, number } = await issueInvoice(order);
    const updated = await updateOrder(id, { invoiceSeries: series, invoiceNumber: number, invoiceError: '' });
    // Factura și pe plata din Stripe (raportul lunar al contabilei).
    if (SECRET) {
      try { await stampPayment(new Stripe(SECRET), id, { ...order, invoiceSeries: series, invoiceNumber: number }); }
      catch (err: any) { console.error('[admin/invoice] factura pe plata Stripe:', err?.message); }
    }
    return json({ ok: true, series, number, order: updated || order });
  } catch (err: any) {
    const message = err?.message || 'Emiterea facturii a eșuat.';
    const updated = await updateOrder(id, { invoiceError: message }).catch(() => null);
    return json({ error: message, order: updated || order }, 502);
  }
};
