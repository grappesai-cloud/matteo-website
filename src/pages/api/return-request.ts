import type { APIRoute } from 'astro';
import { readOrders, updateOrder } from '../../lib/orders-store';
import { sendReturnInstructions, notifyOwnerReturnRequest, notifyConfigured } from '../../lib/notify';
import { RETURN, COMPANY } from '../../lib/legal';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// Cerere de retur din formularul public de pe /retur. Verifică numărul comenzii +
// emailul (ambele trebuie să coincidă cu o comandă reală, ca să nu se poată enumera),
// apoi trimite AUTOMAT clientului adresa de retur + pașii și anunță owner-ul.
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }

  const orderNo = parseInt(String(body?.order ?? '').replace(/\D/g, ''), 10);
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!orderNo || !email || !email.includes('@')) {
    return json({ error: 'Completează numărul comenzii și emailul folosit la comandă.' }, 400);
  }

  const order = (await readOrders()).find(
    (o) => o.number === orderNo && (o.customer?.email || '').trim().toLowerCase() === email,
  );
  // Mesaj generic ca să nu dezvăluim ce comenzi există.
  if (!order) {
    return json({ error: `Nu am găsit o comandă cu numărul #${orderNo} și acest email. Verifică datele sau scrie-ne la ${COMPANY.email}.` }, 404);
  }

  if (order.refundId) {
    return json({ error: 'Această comandă a fost deja rambursată.' }, 409);
  }

  // Comenzi prea vechi: trimite la email (fereastra de retur a expirat oricum).
  const ageDays = (Date.now() - (order.createdAt || Date.now())) / 86_400_000;
  if (ageDays > RETURN.maxRequestAgeDays) {
    return json({ error: `Comanda este mai veche de ${RETURN.maxRequestAgeDays} de zile. Pentru retur scrie-ne direct la ${COMPANY.email}.` }, 422);
  }

  if (!notifyConfigured()) {
    // Fără email nu putem trimite instrucțiunile — direcționăm clientul manual.
    return json({ error: `Nu putem trimite automat acum. Scrie-ne la ${COMPANY.email} cu numărul comenzii #${orderNo}.` }, 503);
  }

  const origin = new URL(request.url).origin;
  const sent = await sendReturnInstructions(order);
  if (!sent.ok) {
    return json({ error: `Nu am putut trimite emailul. Scrie-ne la ${COMPANY.email}.` }, 502);
  }

  // Best-effort: anunță owner-ul + marchează comanda.
  await notifyOwnerReturnRequest(order, origin);
  try { await updateOrder(order.id, { returnRequestedAt: Date.now() }); } catch { /* non-blocking */ }

  return json({ ok: true, message: `Ți-am trimis pe ${order.customer?.email} adresa de retur și pașii de urmat.` });
};
