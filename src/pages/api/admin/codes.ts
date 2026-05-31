import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { isAdmin } from '../../../lib/admin-auth';
import { CURRENCY } from '../../../lib/products';

export const prerender = false;

const SECRET = import.meta.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

function stripeOrError(): Stripe | Response {
  if (!SECRET || SECRET.startsWith('sk_test_xxx')) {
    return json({ error: 'Stripe nu e configurat (STRIPE_SECRET_KEY).' }, 503);
  }
  return new Stripe(SECRET);
}

const str = (v: unknown, max = 80) => String(v ?? '').trim().slice(0, max);

// LIST promotion codes
export const GET: APIRoute = async ({ cookies }) => {
  if (!isAdmin(cookies)) return json({ error: 'Neautorizat.' }, 401);
  const stripe = stripeOrError();
  if (stripe instanceof Response) return stripe;

  const list = await stripe.promotionCodes.list({ limit: 100, expand: ['data.coupon'] });
  const codes = list.data.map((pc) => {
    const c = pc.coupon;
    return {
      id: pc.id,
      code: pc.code,
      active: pc.active,
      timesRedeemed: pc.times_redeemed,
      maxRedemptions: pc.max_redemptions ?? null,
      expiresAt: pc.expires_at ?? null,
      kind: c.percent_off != null ? 'percent' : 'amount',
      value: c.percent_off != null ? c.percent_off : Math.round((c.amount_off ?? 0) / 100),
    };
  });
  return json({ codes });
};

// CREATE coupon + promotion code
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies)) return json({ error: 'Neautorizat.' }, 401);
  const stripe = stripeOrError();
  if (stripe instanceof Response) return stripe;

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }

  const code = str(body?.code, 40).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) return json({ error: 'Codul nu poate fi gol.' }, 400);

  const kind = body?.kind === 'amount' ? 'amount' : 'percent';
  const value = Math.round(Number(body?.value));
  if (!Number.isFinite(value) || value <= 0) return json({ error: 'Valoare invalidă.' }, 400);
  if (kind === 'percent' && value > 100) return json({ error: 'Procentul nu poate depăși 100.' }, 400);

  const maxRedemptions = Number(body?.maxRedemptions) > 0 ? Math.floor(Number(body.maxRedemptions)) : undefined;
  let expiresAt: number | undefined;
  if (body?.expiresAt) {
    const t = Math.floor(new Date(body.expiresAt).getTime() / 1000);
    if (Number.isFinite(t) && t > Date.now() / 1000) expiresAt = t;
  }

  try {
    const coupon = await stripe.coupons.create(
      kind === 'percent'
        ? { percent_off: value, duration: 'once', name: `${code} (-${value}%)` }
        : { amount_off: value * 100, currency: CURRENCY, duration: 'once', name: `${code} (-${value} RON)` }
    );
    const promo = await stripe.promotionCodes.create({
      coupon: coupon.id,
      code,
      ...(maxRedemptions ? { max_redemptions: maxRedemptions } : {}),
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    });
    return json({ ok: true, id: promo.id, code: promo.code });
  } catch (err: any) {
    return json({ error: err?.message || 'Nu am putut crea codul.' }, 500);
  }
};

// DEACTIVATE a promotion code
export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies)) return json({ error: 'Neautorizat.' }, 401);
  const stripe = stripeOrError();
  if (stripe instanceof Response) return stripe;

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const id = str(body?.id, 60);
  if (!id) return json({ error: 'Lipsește id-ul.' }, 400);
  try {
    await stripe.promotionCodes.update(id, { active: false });
    return json({ ok: true });
  } catch (err: any) {
    return json({ error: err?.message || 'Nu am putut dezactiva codul.' }, 500);
  }
};
