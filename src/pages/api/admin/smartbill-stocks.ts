import type { APIRoute } from 'astro';
import { sessionRole } from '../../../lib/admin-auth';
import { listStocks, smartbillConfigured } from '../../../lib/smartbill';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// Listează gestiunile + stocul din SmartBill (read-only). Doar admin.
// Util ca să verificăm ce gestiuni/articole există înainte de a activa useStock.
// GET /api/admin/smartbill-stocks?warehouse=<opțional numele gestiunii>
export const GET: APIRoute = async ({ url, cookies }) => {
  if (!sessionRole(cookies)) return json({ error: 'Neautorizat.' }, 401);
  if (!smartbillConfigured()) return json({ error: 'SmartBill nu e configurat.' }, 503);
  try {
    const warehouse = url.searchParams.get('warehouse') || undefined;
    const data = await listStocks(warehouse);
    return json({ ok: true, data });
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 502);
  }
};
