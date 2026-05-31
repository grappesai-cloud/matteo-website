import type { APIRoute } from 'astro';
import { sessionRole } from '../../../lib/admin-auth';
import { readOrders, updateOrder } from '../../../lib/orders-store';
import { ORDER_STATUSES, type OrderStatus } from '../../../lib/orders';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

const str = (v: unknown, max = 80) => String(v ?? '').trim().slice(0, max);

// LIST — both roles (admin reads the report, ruvix fulfils). Newest first.
export const GET: APIRoute = async ({ cookies }) => {
  if (!sessionRole(cookies)) return json({ error: 'Neautorizat.' }, 401);
  const orders = (await readOrders()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json({ orders });
};

// PATCH — both roles may update fulfillment fields (status / AWB / courier / note).
export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!sessionRole(cookies)) return json({ error: 'Neautorizat.' }, 401);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }

  const id = str(body?.id, 80);
  if (!id) return json({ error: 'Lipsește id-ul comenzii.' }, 400);

  const patch: { status?: OrderStatus; awb?: string; courier?: string; note?: string } = {};
  if (body?.status !== undefined) {
    const s = str(body.status, 20) as OrderStatus;
    if (!ORDER_STATUSES.includes(s)) return json({ error: 'Status invalid.' }, 400);
    patch.status = s;
  }
  if (body?.awb !== undefined) patch.awb = str(body.awb, 60);
  if (body?.courier !== undefined) patch.courier = str(body.courier, 40);
  if (body?.note !== undefined) patch.note = str(body.note, 300);

  try {
    const updated = await updateOrder(id, patch);
    if (!updated) return json({ error: 'Comandă inexistentă.' }, 404);
    return json({ ok: true, order: updated });
  } catch (err: any) {
    return json({ error: err?.message || 'Salvarea a eșuat.' }, 500);
  }
};
