// === PROMO CODES — pornire programată ===
// Stripe știe să EXPIRE un cod (expires_at), dar nu are „activ de la”. Un cod cu
// start în viitor e creat INACTIV, cu ora de start (secunde unix) în
// `metadata.starts_at`. `activateDueCodes()` îl pornește când i-a venit ora.
// Rulează înaintea fiecărei sesiuni de checkout și la listarea codurilor în
// admin, deci un client nu prinde niciodată codul încă oprit după ora de start.

import type Stripe from 'stripe';

export const STARTS_AT_KEY = 'starts_at';

/** Cache pe proces: nu batem Stripe la fiecare checkout dacă nimic nu poate fi scadent. */
let nextCheckAt = 0;

/** Ora de start programată (secunde unix) sau null când codul nu e programat. */
export function startsAtOf(pc: Stripe.PromotionCode): number | null {
  const v = Number(pc.metadata?.[STARTS_AT_KEY]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Pornește codurile programate a căror oră a trecut. Întoarce codurile pornite.
 * `force` sare peste cache (adminul vrea întotdeauna starea reală).
 */
export async function activateDueCodes(stripe: Stripe, force = false): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);
  if (!force && now < nextCheckAt) return [];

  const list = await stripe.promotionCodes.list({ active: false, limit: 100 });
  const activated: string[] = [];
  let soonest = Infinity;

  for (const pc of list.data) {
    const at = startsAtOf(pc);
    if (at == null) continue;
    if (pc.expires_at && pc.expires_at <= now) continue; // a expirat înainte să pornească; rămâne oprit
    if (at <= now) {
      await stripe.promotionCodes.update(pc.id, { active: true, metadata: { [STARTS_AT_KEY]: '' } });
      activated.push(pc.code);
    } else if (at < soonest) {
      soonest = at;
    }
  }

  // Următoarea verificare: la cel mai apropiat start, dar cel mult peste 5 minute,
  // ca un cod programat între timp (sau de alt container) să fie prins repede.
  nextCheckAt = Math.min(soonest, now + 300);
  return activated;
}
