// === STOCK LEDGER — rezervări + scădere o singură dată ===
// Funcții PURE peste lista de produse din catalog. Nu ating R2; catalog-store.ts
// le rulează în interiorul unei scrieri condiționate (ETag), deci stocul și
// registrul se schimbă împreună, atomic, sau deloc.
//
// Registrul stă PE FIECARE PRODUS (`product.holds[cheie]`), nu într-un obiect
// separat: așa fișierul din R2 rămâne aceeași listă de produse ca până acum, iar
// un container vechi rămas pornit după deploy (Coolify le ține pe amândouă ~18 min)
// citește catalogul normal, fără să cadă pe seed sau să-l suprascrie.
//
// Cheia unei rezervări = tokenul `pc` din metadata sesiunii Stripe (sau id-ul
// sesiunii pentru sesiuni vechi). Stări:
//   • held      — bucățile sunt scăzute din stoc, clientul e pe pagina Stripe
//   • consumed  — plata a venit; scăderea rămâne (nu se mai scade încă o dată)
//   • released  — sesiunea a expirat / a fost abandonată; bucățile s-au întors
//   • restocked — rambursare cu „repune în stoc”; bucățile s-au întors
// Orice tranziție e idempotentă: același eveniment Stripe livrat de 3 ori are
// același efect ca livrat o dată.

import type { Product, SizeKey } from './products';

export interface HoldItem { slug: string; color: string; size: string; qty: number }

export type HoldState = 'held' | 'consumed' | 'released' | 'restocked';

export interface StockHold {
  items: HoldItem[];  // doar articolele ACESTUI produs
  state: HoldState;
  at: number;         // ms epoch — când a fost creată
  updatedAt: number;  // ms epoch — ultima tranziție
}

/** Cât stă o rezervare „held” înainte s-o eliberăm singuri (sesiunea Stripe e de 35 min). */
export const HOLD_MAX_AGE_MS = 50 * 60 * 1000;
/** Intrările terminale se șterg după 7 zile, ca JSON-ul să nu crească la nesfârșit. */
export const HOLD_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Normalizează articolele din coș (format compact `{s,c,z,q}` sau complet). */
export function normalizeItems(raw: unknown): HoldItem[] {
  if (!Array.isArray(raw)) return [];
  const out: HoldItem[] = [];
  for (const it of raw as any[]) {
    const slug = String(it?.slug ?? it?.s ?? '').trim();
    const color = String(it?.color ?? it?.c ?? '').trim();
    const size = String(it?.size ?? it?.z ?? '').trim();
    const qty = Math.max(1, Math.floor(Number(it?.qty ?? it?.q) || 1));
    if (slug && size) out.push({ slug, color, size, qty });
  }
  return out;
}

function colorOf(p: Product, colorKey: string) {
  return p.colors.find((c) => c.key === colorKey) ?? p.colors[0];
}

/** Articolele grupate pe produs, doar pentru produsele cu stoc urmărit. */
function trackedByProduct(products: Product[], items: HoldItem[]): Map<Product, HoldItem[]> {
  const map = new Map<Product, HoldItem[]>();
  for (const it of items) {
    const p = products.find((x) => x.slug === it.slug);
    if (!p || !p.trackStock) continue;
    map.set(p, [...(map.get(p) || []), it]);
  }
  return map;
}

function adjust(p: Product, items: HoldItem[], sign: 1 | -1): void {
  for (const it of items) {
    const color = colorOf(p, it.color);
    if (!color) continue;
    color.stock = color.stock || {};
    const cur = Number(color.stock[it.size as SizeKey]) || 0;
    color.stock[it.size as SizeKey] = Math.max(0, cur + sign * it.qty);
  }
}

export type ReserveResult =
  | { ok: true; already: boolean }
  | { ok: false; error: string; slug?: string; size?: string };

/**
 * Rezervă bucățile pentru o sesiune de checkout: le scade din stoc ACUM și ține
 * minte rezervarea. Dacă nu ajunge stocul, nu schimbă nimic și spune ce lipsește.
 * Idempotent pe cheie (același token nu rezervă de două ori).
 */
export function reserveStock(products: Product[], key: string, rawItems: unknown, now = Date.now()): ReserveResult {
  if (products.some((p) => p.holds?.[key])) return { ok: true, already: true };

  const byProduct = trackedByProduct(products, normalizeItems(rawItems));
  // Verificare pe TOATE înainte de a scădea ceva (două rânduri cu aceeași mărime se adună).
  for (const [p, items] of byProduct) {
    const need = new Map<string, number>();
    for (const it of items) need.set(`${it.color}|${it.size}`, (need.get(`${it.color}|${it.size}`) || 0) + it.qty);
    for (const [k, q] of need) {
      const [colorKey, size] = k.split('|');
      const have = Number(colorOf(p, colorKey)?.stock?.[size as SizeKey]) || 0;
      if (have < q) return { ok: false, error: `Stoc insuficient: ${p.name} (${size}).`, slug: p.slug, size };
    }
  }
  if (!byProduct.size) return { ok: true, already: false }; // nimic de urmărit → fără rezervare

  for (const [p, items] of byProduct) {
    adjust(p, items, -1);
    p.holds = p.holds || {};
    p.holds[key] = { items, state: 'held', at: now, updatedAt: now };
  }
  return { ok: true, already: false };
}

/**
 * Plata a venit: rezervarea devine scădere definitivă. Dacă sesiunea nu avea
 * rezervare (sesiune veche, dinainte de registru, sau rezervare eliberată între
 * timp), scade acum. O singură dată, oricâte livrări ale evenimentului vin.
 */
export function consumeStock(products: Product[], key: string, rawItems: unknown, now = Date.now()): { decrementedNow: boolean; alreadyDone: boolean } {
  let decrementedNow = false;
  let touched = 0;
  let already = 0;
  for (const [p, items] of trackedByProduct(products, normalizeItems(rawItems))) {
    touched++;
    const hold = p.holds?.[key];
    if (hold?.state === 'consumed') { already++; continue; }
    if (hold?.state === 'held') {
      hold.state = 'consumed';
      hold.updatedAt = now;
      continue;
    }
    // fără rezervare (sau eliberată): scădem acum și marcăm
    adjust(p, items, -1);
    p.holds = p.holds || {};
    p.holds[key] = { items, state: 'consumed', at: hold?.at ?? now, updatedAt: now };
    decrementedNow = true;
  }
  return { decrementedNow, alreadyDone: touched > 0 && already === touched };
}

/** Sesiunea a expirat / a fost abandonată: bucățile se întorc în stoc. Idempotent. */
export function releaseStock(products: Product[], key: string, now = Date.now()): boolean {
  let released = false;
  for (const p of products) {
    const hold = p.holds?.[key];
    if (!hold || hold.state !== 'held') continue;
    adjust(p, hold.items, +1);
    hold.state = 'released';
    hold.updatedAt = now;
    released = true;
  }
  return released;
}

/**
 * Rambursare cu „repune în stoc”: bucățile comenzii se întorc (doar produsele
 * cu stoc urmărit). O singură dată pe comandă (cheie `restock:<orderId>`).
 */
export function restockOrder(products: Product[], orderId: string, rawItems: unknown, now = Date.now()): boolean {
  const key = `restock:${orderId}`;
  let restocked = false;
  for (const [p, items] of trackedByProduct(products, normalizeItems(rawItems))) {
    if (p.holds?.[key]) continue;
    adjust(p, items, +1);
    p.holds = p.holds || {};
    p.holds[key] = { items, state: 'restocked', at: now, updatedAt: now };
    restocked = true;
  }
  return restocked;
}

/**
 * Curățenie: eliberează rezervările „held” mai vechi decât HOLD_MAX_AGE_MS (plasa
 * de siguranță dacă evenimentul `checkout.session.expired` nu ajunge) și șterge
 * intrările terminale mai vechi de HOLD_KEEP_MS. Întoarce câte a eliberat.
 */
export function sweepHolds(products: Product[], now = Date.now()): number {
  let released = 0;
  for (const p of products) {
    if (!p.holds) continue;
    for (const [key, hold] of Object.entries(p.holds)) {
      if (hold.state === 'held' && now - hold.at > HOLD_MAX_AGE_MS) {
        adjust(p, hold.items, +1);
        hold.state = 'released';
        hold.updatedAt = now;
        released++;
      } else if (hold.state !== 'held' && now - hold.updatedAt > HOLD_KEEP_MS) {
        delete p.holds[key];
      }
    }
    if (!Object.keys(p.holds).length) delete p.holds;
  }
  return released;
}
