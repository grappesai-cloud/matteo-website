import type { APIRoute } from 'astro';
import { fanConfigured, listCounties, listLocalities, lookupZip } from '../../../lib/fancourier';

// Public geo proxy for the checkout address form (the FAN token must not reach the
// browser). Read-only, effectively-static data — cached in the FAN lib.
//   GET /api/fan/geo?type=counties
//   GET /api/fan/geo?type=localities&county=Prahova
//   GET /api/fan/geo?type=zip&county=Prahova&locality=Ploiesti&street=Republicii
export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': s === 200 ? 'public, max-age=3600' : 'no-store' },
  });

export const GET: APIRoute = async ({ url }) => {
  if (!fanConfigured()) return json({ error: 'FAN indisponibil', items: [] }, 503);
  const type = url.searchParams.get('type') || '';
  const county = (url.searchParams.get('county') || '').trim();
  const locality = (url.searchParams.get('locality') || '').trim();
  const street = (url.searchParams.get('street') || '').trim();
  try {
    if (type === 'counties') return json({ items: await listCounties() });
    if (type === 'localities') {
      if (!county) return json({ error: 'Lipsește județul.', items: [] }, 400);
      return json({ items: await listLocalities(county) });
    }
    if (type === 'zip') {
      if (!county || !locality || !street) return json({ zip: '' });
      return json({ zip: await lookupZip(county, locality, street) });
    }
    return json({ error: 'type invalid' }, 400);
  } catch (err: any) {
    return json({ error: err?.message || 'Eroare FAN', items: [] }, 502);
  }
};
