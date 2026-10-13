// === PROMO — validarea unui cod de reducere pe partea noastră ===
// Codul se verifică în Stripe înainte de a deschide sesiunea, ca site-ul să
// arate reducerea în total ÎNAINTE de plată (nu doar pe pagina Stripe). Stripe
// rămâne autoritar: sesiunea se creează cu `discounts: [{ promotion_code }]`,
// iar ce s-a plătit efectiv se citește din `total_details.amount_discount`.

import type Stripe from 'stripe';
import { CURRENCY } from './products';
import { activateDueCodes } from './promo-codes';

export interface PromoInfo {
  id: string;            // promotion code id (promo_…)
  code: string;          // ce a tastat clientul, normalizat (NUNTA25)
  kind: 'percent' | 'amount';
  value: number;         // procent, sau RON pentru reducere fixă
  minSubtotal?: number;  // RON — restricție Stripe (minimum_amount), dacă există
}

export type PromoLookup = { ok: true; promo: PromoInfo } | { ok: false; error: string };

/** Același normalizator ca la crearea codului în admin (A-Z 0-9). */
export function normalizeCode(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
}

/** Caută codul în Stripe și verifică tot ce putem verifica fără client. */
export async function lookupPromo(stripe: Stripe, rawCode: unknown): Promise<PromoLookup> {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, error: 'Scrie un cod de reducere.' };

  // Codurile programate pornesc singure când le vine ora (lib/promo-codes.ts).
  try { await activateDueCodes(stripe); } catch (err: any) { console.error('[promo] activare coduri programate:', err?.message); }

  const list = await stripe.promotionCodes.list({ code, active: true, limit: 1, expand: ['data.coupon'] });
  const pc = list.data[0];
  if (!pc) return { ok: false, error: 'Codul nu există sau nu mai e activ.' };

  const now = Math.floor(Date.now() / 1000);
  if (pc.expires_at && pc.expires_at <= now) return { ok: false, error: 'Codul a expirat.' };
  if (pc.max_redemptions && pc.times_redeemed >= pc.max_redemptions) {
    return { ok: false, error: 'Codul a atins numărul maxim de utilizări.' };
  }
  const c = pc.coupon;
  if (!c || c.valid === false) return { ok: false, error: 'Codul nu mai e valid.' };
  if (c.amount_off != null && String(c.currency || '').toLowerCase() !== CURRENCY) {
    return { ok: false, error: 'Codul e pentru altă monedă.' };
  }
  const min = pc.restrictions?.minimum_amount;
  const minSubtotal = min && String(pc.restrictions?.minimum_amount_currency || CURRENCY).toLowerCase() === CURRENCY
    ? Math.round(min) / 100
    : undefined;

  return {
    ok: true,
    promo: {
      id: pc.id,
      code: pc.code,
      kind: c.percent_off != null ? 'percent' : 'amount',
      value: c.percent_off != null ? Number(c.percent_off) : Math.round(Number(c.amount_off) || 0) / 100,
      ...(minSubtotal ? { minSubtotal } : {}),
    },
  };
}

/**
 * Eticheta codului folosit într-o sesiune plătită (ex. „NUNTA25”). În evenimentul
 * de webhook `discounts[].promotion_code` vine ca id (`promo_…`), deci îl citim
 * din Stripe. Best-effort: la orice eroare întoarce ''.
 */
export async function promoLabelForSession(stripe: Stripe, session: any): Promise<string> {
  const d = Array.isArray(session?.discounts) ? session.discounts[0] : null;
  if (!d) return '';
  const pc = d.promotion_code;
  try {
    if (pc && typeof pc === 'object' && pc.code) return String(pc.code);
    if (typeof pc === 'string' && pc) return String((await stripe.promotionCodes.retrieve(pc)).code || '');
    const c = d.coupon;
    if (c && typeof c === 'object' && c.name) return String(c.name);
    if (typeof c === 'string' && c) return String((await stripe.coupons.retrieve(c)).name || '');
  } catch (err: any) {
    console.error('[promo] nu am putut citi codul folosit:', err?.message);
  }
  return '';
}

/**
 * Reducerea estimată (RON, cu bani) pentru un subtotal de produse. Stripe aplică
 * procentul pe totalul produselor și rotunjește la ban; transportul nu intră.
 */
export function discountFor(promo: PromoInfo, subtotalRon: number): number {
  const subBani = Math.round(subtotalRon * 100);
  if (promo.minSubtotal && subtotalRon < promo.minSubtotal) return 0;
  const bani = promo.kind === 'percent'
    ? Math.round(subBani * promo.value / 100)
    : Math.min(subBani, Math.round(promo.value * 100));
  return Math.max(0, bani) / 100;
}
