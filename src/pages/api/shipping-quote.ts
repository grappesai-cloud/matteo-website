import type { APIRoute } from 'astro';
import { readCatalog } from '../../lib/catalog-store';
import { effectivePrice, shippingFor } from '../../lib/products';
import { fanConfigured, getInternalTariff, parcelWeightForUnits } from '../../lib/fancourier';

// Live shipping quote for the checkout address step. Given the cart + destination
// (county, locality), returns the REAL FAN tariff. Falls back to the flat rate when
// FAN is unavailable so checkout never dead-ends. The price is recomputed
// authoritatively server-side again in /api/checkout — this endpoint is for display.
export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

interface Incoming { slug?: string; color?: string; size?: string; qty?: number }

export async function quoteShipping(
  items: Incoming[],
  county: string,
  locality: string,
): Promise<{ shipping: number; source: 'fan' | 'flat'; subtotal: number; units: number }> {
  const catalog = await readCatalog();
  let subtotal = 0;
  let units = 0;
  for (const raw of items) {
    const p = catalog.find((x) => x.slug === String(raw?.slug ?? '') && x.active !== false);
    if (!p) continue;
    const qty = Math.min(10, Math.max(1, Math.floor(Number(raw?.qty) || 1)));
    subtotal += effectivePrice(p) * qty;
    units += qty;
  }
  // Free shipping still honours the storefront threshold, whatever FAN would cost.
  if (shippingFor(subtotal) === 0) return { shipping: 0, source: 'flat', subtotal, units };

  if (county && locality && fanConfigured()) {
    try {
      const t = await getInternalTariff({
        county,
        locality,
        weight: parcelWeightForUnits(units),
        declaredValue: subtotal,
      });
      // Round up to the whole leu so we never under-charge on a fractional tariff.
      return { shipping: Math.ceil(t.total), source: 'fan', subtotal, units };
    } catch (err: any) {
      console.error('[shipping-quote] FAN tariff failed, using flat:', err?.message);
    }
  }
  return { shipping: shippingFor(subtotal), source: 'flat', subtotal, units };
}

export const POST: APIRoute = async ({ request }) => {
  let payload: { items?: Incoming[]; county?: string; locality?: string };
  try { payload = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) return json({ error: 'Coșul este gol.' }, 400);
  try {
    const q = await quoteShipping(items, String(payload?.county || '').trim(), String(payload?.locality || '').trim());
    return json({ shipping: q.shipping, source: q.source, subtotal: q.subtotal });
  } catch (err: any) {
    return json({ error: err?.message || 'Nu am putut calcula transportul.' }, 500);
  }
};
