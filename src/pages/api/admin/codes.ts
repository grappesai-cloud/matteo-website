import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { isAdmin } from '../../../lib/admin-auth';
import { CURRENCY } from '../../../lib/products';
import { STARTS_AT_KEY, activateDueCodes, startsAtOf } from '../../../lib/promo-codes';

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

/**
 * Moment din formular → secunde unix. O dată fără oră („2026-10-31") înseamnă
 * sfârșitul acelei zile în România; folosim +02:00 fix, deci vara expiră cu o
 * oră mai târziu decât miezul nopții, niciodată mai devreme.
 */
function parseWhen(v: unknown): number | undefined {
  const raw = str(v, 40);
  if (!raw) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59+02:00` : raw;
  const t = Math.floor(new Date(iso).getTime() / 1000);
  return Number.isFinite(t) ? t : undefined;
}

// LIST promotion codes (pornește mai întâi codurile programate scadente)
export const GET: APIRoute = async ({ cookies }) => {
  if (!isAdmin(cookies)) return json({ error: 'Neautorizat.' }, 401);
  const stripe = stripeOrError();
  if (stripe instanceof Response) return stripe;

  try { await activateDueCodes(stripe, true); } catch (err: any) { console.error('[codes] activare programată:', err?.message); }

  const now = Math.floor(Date.now() / 1000);
  const list = await stripe.promotionCodes.list({ limit: 100, expand: ['data.coupon'] });
  const codes = list.data.map((pc) => {
    const c = pc.coupon;
    const startsAt = startsAtOf(pc);
    return {
      id: pc.id,
      code: pc.code,
      active: pc.active,
      scheduled: !pc.active && startsAt != null && startsAt > now,
      startsAt,
      timesRedeemed: pc.times_redeemed,
      maxRedemptions: pc.max_redemptions ?? null,
      expiresAt: pc.expires_at ?? null,
      kind: c.percent_off != null ? 'percent' : 'amount',
      value: c.percent_off != null ? c.percent_off : Math.round((c.amount_off ?? 0) / 100),
    };
  });
  return json({ codes });
};

// CREATE coupon + promotion code (opțional programat: `startsAt` în viitor → creat inactiv)
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

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = parseWhen(body?.expiresAt);
  if (expiresAt !== undefined && expiresAt <= now) return json({ error: 'Data de expirare e în trecut.' }, 400);

  // Start în viitor (cu o marjă de 30 s) = cod programat; altfel pornește acum.
  const startsAtRaw = parseWhen(body?.startsAt);
  const startsAt = startsAtRaw !== undefined && startsAtRaw > now + 30 ? startsAtRaw : undefined;
  if (startsAt && expiresAt && startsAt >= expiresAt) {
    return json({ error: 'Ora de start trebuie să fie înaintea expirării.' }, 400);
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
      ...(startsAt ? { active: false, metadata: { [STARTS_AT_KEY]: String(startsAt) } } : {}),
    });
    return json({ ok: true, id: promo.id, code: promo.code, active: promo.active, startsAt: startsAt ?? null, expiresAt: expiresAt ?? null });
  } catch (err: any) {
    return json({ error: err?.message || 'Nu am putut crea codul.' }, 500);
  }
};

// ACTIVATE NOW a scheduled (or deactivated) promotion code
export const PATCH: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies)) return json({ error: 'Neautorizat.' }, 401);
  const stripe = stripeOrError();
  if (stripe instanceof Response) return stripe;

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const id = str(body?.id, 60);
  if (!id) return json({ error: 'Lipsește id-ul.' }, 400);
  try {
    const promo = await stripe.promotionCodes.update(id, { active: true, metadata: { [STARTS_AT_KEY]: '' } });
    return json({ ok: true, active: promo.active });
  } catch (err: any) {
    return json({ error: err?.message || 'Nu am putut activa codul.' }, 500);
  }
};

// DEACTIVATE a promotion code (și anulează programarea, ca să nu repornească singur)
export const DELETE: APIRoute = async ({ request, cookies }) => {
  if (!isAdmin(cookies)) return json({ error: 'Neautorizat.' }, 401);
  const stripe = stripeOrError();
  if (stripe instanceof Response) return stripe;

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const id = str(body?.id, 60);
  if (!id) return json({ error: 'Lipsește id-ul.' }, 400);
  try {
    await stripe.promotionCodes.update(id, { active: false, metadata: { [STARTS_AT_KEY]: '' } });
    return json({ ok: true });
  } catch (err: any) {
    return json({ error: err?.message || 'Nu am putut dezactiva codul.' }, 500);
  }
};
