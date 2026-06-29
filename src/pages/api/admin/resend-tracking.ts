import type { APIRoute } from 'astro';
import { sessionRole } from '../../../lib/admin-auth';
import { readOrders, updateOrder } from '../../../lib/orders-store';
import { sendCustomerShipped, notifyConfigured } from '../../../lib/notify';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

const envv = (k: string) => (process.env[k] || (import.meta.env as any)[k] || '').trim();

// Diagnostics: which SMTP host/port is configured (no secrets). Admin-only.
export const GET: APIRoute = async ({ cookies }) => {
  if (!sessionRole(cookies)) return json({ error: 'Neautorizat.' }, 401);
  return json({
    configured: notifyConfigured(),
    host: envv('SMTP_HOST') || null,
    port: Number(envv('SMTP_PORT')) || 465,
    user: envv('SMTP_USER') || null,
  });
};

// Force-send the "comanda a fost expediată" tracking email to the customer, even
// if it was already sent (covers orders shipped before this feature existed).
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!sessionRole(cookies)) return json({ error: 'Neautorizat.' }, 401);
  if (!notifyConfigured()) return json({ error: 'SMTP nu e configurat — emailul nu poate fi trimis.' }, 503);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const id = String(body?.id ?? '').trim();
  if (!id) return json({ error: 'Lipsește id-ul comenzii.' }, 400);

  // Optional override recipient — for sending a test copy to a chosen address
  // without touching the real customer or stamping the order as notified.
  const emailOverride = String(body?.email ?? '').trim();
  if (emailOverride && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailOverride)) {
    return json({ error: 'Adresă de email invalidă.' }, 400);
  }

  const order = (await readOrders()).find((o) => o.id === id);
  if (!order) return json({ error: 'Comandă inexistentă.' }, 404);
  if (!order.awb) return json({ error: 'Comanda nu are AWB — nu există ce urmări.' }, 400);
  if (!emailOverride && !order.customer?.email) return json({ error: 'Comanda nu are email de client.' }, 400);

  const res = await sendCustomerShipped(order, emailOverride || undefined);
  if (!res.ok) {
    // Surface the real SMTP error on test sends so config issues are diagnosable.
    return json({ error: emailOverride ? `Trimiterea a eșuat: ${res.error}` : 'Trimiterea emailului a eșuat (vezi logurile).' }, 502);
  }

  // Only stamp the order when the REAL customer was notified, not on a test send.
  if (!emailOverride) {
    const updated = await updateOrder(id, { shippedEmailAt: Date.now() });
    return json({ ok: true, order: updated || order });
  }
  return json({ ok: true, test: true, sentTo: emailOverride });
};
