import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { readCatalog } from '../../lib/catalog-store';
import { effectivePrice } from '../../lib/products';
import { discountFor, lookupPromo } from '../../lib/promo';

// Verifică un cod de reducere pentru coșul curent și întoarce reducerea estimată,
// ca pagina /merch/checkout să arate totalul corect înainte de plată. Codul se
// re-verifică autoritar în /api/checkout când se deschide sesiunea Stripe.
export const prerender = false;

const SECRET = import.meta.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

interface Incoming { slug?: string; qty?: number }

export const POST: APIRoute = async ({ request }) => {
  if (!SECRET || SECRET.startsWith('sk_test_xxx')) return json({ error: 'Codurile de reducere nu sunt disponibile momentan.' }, 503);

  let payload: { code?: string; items?: Incoming[] };
  try { payload = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  const catalog = await readCatalog();
  let subtotal = 0;
  for (const raw of items) {
    const p = catalog.find((x) => x.slug === String(raw?.slug ?? '') && x.active !== false);
    if (!p) continue;
    const qty = Math.min(10, Math.max(1, Math.floor(Number(raw?.qty) || 1)));
    subtotal += effectivePrice(p) * qty;
  }

  try {
    const found = await lookupPromo(new Stripe(SECRET), payload?.code);
    if (!found.ok) return json({ error: found.error }, 422);
    const discount = discountFor(found.promo, subtotal);
    if (found.promo.minSubtotal && subtotal < found.promo.minSubtotal) {
      return json({ error: `Codul se aplică de la ${found.promo.minSubtotal} RON.` }, 422);
    }
    return json({ ok: true, promo: found.promo, subtotal, discount });
  } catch (err: any) {
    console.error('[promo-check] Stripe error:', err?.message || err);
    return json({ error: 'Nu am putut verifica codul. Încearcă din nou.' }, 500);
  }
};
