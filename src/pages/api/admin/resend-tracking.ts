import type { APIRoute } from 'astro';
import { sessionRole } from '../../../lib/admin-auth';
import { readOrders, updateOrder } from '../../../lib/orders-store';
import { notifyCustomerShipped, notifyConfigured } from '../../../lib/notify';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// Force-send the "comanda a fost expediată" tracking email to the customer, even
// if it was already sent (covers orders shipped before this feature existed).
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!sessionRole(cookies)) return json({ error: 'Neautorizat.' }, 401);
  if (!notifyConfigured()) return json({ error: 'SMTP nu e configurat — emailul nu poate fi trimis.' }, 503);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const id = String(body?.id ?? '').trim();
  if (!id) return json({ error: 'Lipsește id-ul comenzii.' }, 400);

  const order = (await readOrders()).find((o) => o.id === id);
  if (!order) return json({ error: 'Comandă inexistentă.' }, 404);
  if (!order.awb) return json({ error: 'Comanda nu are AWB — nu există ce urmări.' }, 400);
  if (!order.customer?.email) return json({ error: 'Comanda nu are email de client.' }, 400);

  const sent = await notifyCustomerShipped(order);
  if (!sent) return json({ error: 'Trimiterea emailului a eșuat (vezi logurile).' }, 502);

  const updated = await updateOrder(id, { shippedEmailAt: Date.now() });
  return json({ ok: true, order: updated || order });
};
