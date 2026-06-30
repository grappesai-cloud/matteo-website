import type { APIRoute } from 'astro';
import { sessionRole } from '../../../lib/admin-auth';
import { readOrders, updateOrder } from '../../../lib/orders-store';
import { createAwb, deleteAwb, fanConfigured } from '../../../lib/fancourier';
import { maybeNotifyShipped } from '../../../lib/notify';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// Generate a FAN Courier AWB for an order, then stamp it (awb + courier + shipped).
// Both roles may trigger it (Ruvix is the one shipping).
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!sessionRole(cookies)) return json({ error: 'Neautorizat.' }, 401);
  if (!fanConfigured()) {
    return json({ error: 'FAN Courier nu e configurat (FAN_USERNAME / FAN_PASSWORD / FAN_CLIENT_ID).' }, 503);
  }

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const id = String(body?.id ?? '').trim();
  if (!id) return json({ error: 'Lipsește id-ul comenzii.' }, 400);

  const order = (await readOrders()).find((o) => o.id === id);
  if (!order) return json({ error: 'Comandă inexistentă.' }, 404);
  if (order.awb) return json({ error: `Comanda are deja AWB (${order.awb}).` }, 409);

  let awb: string;
  try {
    ({ awb } = await createAwb(order));
  } catch (err: any) {
    return json({ error: err?.message || 'Generarea AWB a eșuat.' }, 502);
  }

  try {
    const updated = await updateOrder(id, { awb, courier: 'FAN Courier', status: 'shipped' });
    // Email the customer their tracking link (once).
    const finalOrder = updated ? await maybeNotifyShipped(updated) : updated;
    return json({ ok: true, awb, order: finalOrder });
  } catch (err: any) {
    // AWB exists at FAN but we failed to persist — surface the number so it isn't lost.
    return json({ error: `AWB generat (${awb}) dar salvarea a eșuat: ${err?.message || ''}`, awb }, 500);
  }
};

// Cancel/delete an order's FAN AWB (only works before the courier picks it up),
// then clear the AWB from the order and reset its status back to new.
export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!sessionRole(cookies)) return json({ error: 'Neautorizat.' }, 401);
  if (!fanConfigured()) {
    return json({ error: 'FAN Courier nu e configurat (FAN_USERNAME / FAN_PASSWORD / FAN_CLIENT_ID).' }, 503);
  }

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const id = String(body?.id ?? '').trim();
  if (!id) return json({ error: 'Lipsește id-ul comenzii.' }, 400);

  const order = (await readOrders()).find((o) => o.id === id);
  if (!order) return json({ error: 'Comandă inexistentă.' }, 404);
  if (!order.awb) return json({ error: 'Comanda nu are AWB de șters.' }, 400);

  try {
    await deleteAwb(order.awb);
  } catch (err: any) {
    return json({ error: err?.message || 'Ștergerea AWB a eșuat.' }, 502);
  }

  try {
    const updated = await updateOrder(id, { awb: '', courier: '', status: 'new', shippedEmailAt: 0 });
    return json({ ok: true, order: updated || order });
  } catch (err: any) {
    return json({ error: `AWB șters la FAN dar resetarea comenzii a eșuat: ${err?.message || ''}` }, 500);
  }
};
