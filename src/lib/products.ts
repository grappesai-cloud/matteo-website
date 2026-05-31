// === MERCH CATALOG — types, constants & seed data ===
// The live catalog is stored in Vercel Blob (see catalog-store.ts). This file
// holds the shape, shared config, and the SEED used to initialise the store
// (and as a graceful fallback when Blob isn't configured yet).

export const CURRENCY = 'ron' as const;
export const CURRENCY_LABEL = 'RON';

/** Free shipping kicks in at this subtotal (RON). Below it, a flat rate applies. */
export const FREE_SHIPPING_THRESHOLD = 250;
/** Flat shipping rate (RON) charged below the free-shipping threshold. */
export const SHIPPING_FLAT = 20;

export type SizeKey = 'S' | 'M' | 'L' | 'XL' | 'XXL';
export const SIZES: SizeKey[] = ['S', 'M', 'L', 'XL', 'XXL'];

export type ColorKey = string; // 'black' | 'pink' | custom (admin-defined)

export interface ProductColor {
  key: ColorKey;
  label: string;   // shown in UI, RO
  swatch: string;  // hex used for the selector dot
  front: string;   // image url (local /images or Blob https url)
  back: string;    // image url
  stock?: Partial<Record<SizeKey, number>>; // per-size units (only when trackStock)
}

export interface Product {
  id: string;            // stable id (used for admin edit)
  slug: string;          // url slug, unique
  artist: string;        // artist slug (base ARTISTS or admin-created)
  artistName?: string;   // display name for admin-created artists (base ones resolve via ARTISTS)
  name: string;
  subtitle: string;      // short line under the name
  price: number;         // RON, whole units
  description: string;   // RO marketing copy
  details: string[];     // bullet specs (RO)
  badge?: string;        // optional ribbon, e.g. "Diptic"
  colors: ProductColor[];
  sizes: SizeKey[];
  active?: boolean;      // shown in shop when true (default true)
  sort?: number;         // ascending display order
  discountPercent?: number; // 0–90, applied to price
  trackStock?: boolean;     // when true, per-variant stock is enforced
}

export interface ArtistTab {
  slug: string;
  name: string;
}

/** Base artists, always shown as filter tabs / admin sections. */
export const ARTISTS: ArtistTab[] = [
  { slug: 'andrei', name: 'Andrei Bănuță' },
  { slug: 'matteo', name: 'Matteo' },
  { slug: 'georgiana', name: 'Georgiana Neagu' },
  { slug: 'emily', name: 'Emily Istrate' },
];

/** Base artists merged with any admin-created artists found in the catalog. */
export function catalogArtists(products: Product[]): ArtistTab[] {
  const map = new Map<string, string>();
  for (const a of ARTISTS) map.set(a.slug, a.name);
  for (const p of products) {
    if (p.artist && !map.has(p.artist)) map.set(p.artist, p.artistName || p.artist);
  }
  return [...map.entries()].map(([slug, name]) => ({ slug, name }));
}

/** Display name for an artist slug (base list first, then catalog-derived). */
export function artistLabel(slug: string, products: Product[]): string {
  const base = ARTISTS.find((a) => a.slug === slug);
  if (base) return base.name;
  const p = products.find((x) => x.artist === slug && x.artistName);
  return p?.artistName || slug;
}

const IMG = '/images/merch/andrei';

const SHARED_DETAILS: string[] = [
  'Croială oversized unisex',
  '100% bumbac premium, 240 g/m²',
  'Print pe față și pe spate',
  'Ediție limitată Andrei Bănuță × Mattman',
];

/** Initial catalog — written to Blob on first run, and used as fallback. */
export const seedProducts: Product[] = [
  {
    id: 'seed-bagabont',
    slug: 'suflet-de-bagabont',
    artist: 'andrei',
    name: 'Suflet de Bagabont',
    subtitle: 'Oversized · ediție de autor',
    price: 130,
    badge: 'Best seller',
    description:
      'Tricoul inspirat din „Suflet de Bagabont”, piesa care a trecut de 90 de milioane de vizualizări. În față stă manifestul: „Am sufletul de bagabont, da’ inima mea e locu’ tău”. Pe spate, inima din fire roșii, semnătura vizuală a colecției.',
    details: SHARED_DETAILS,
    colors: [
      { key: 'black', label: 'Negru', swatch: '#111111', front: `${IMG}/bagabont-front.webp`, back: `${IMG}/bagabont-back.webp` },
    ],
    sizes: SIZES,
    active: true,
    sort: 1,
  },
  {
    id: 'seed-mama',
    slug: 'mama-copiilor-mei',
    artist: 'andrei',
    name: 'Mama Copiilor Mei',
    subtitle: 'Oversized · diptic',
    price: 130,
    badge: 'Diptic',
    description:
      'Pentru ea. „Mama copiilor mei” scris apăsat în față, legat de firul roșu al destinului, iar pe spate inima care bate pentru familie. Jumătatea feminină a dipticului Mama & Tata, gândit să fie purtat în doi.',
    details: SHARED_DETAILS,
    colors: [
      { key: 'black', label: 'Negru', swatch: '#111111', front: `${IMG}/mama-front.webp`, back: `${IMG}/mama-back.webp` },
    ],
    sizes: SIZES,
    active: true,
    sort: 2,
  },
  {
    id: 'seed-tatal',
    slug: 'tatal-copiilor-mei',
    artist: 'andrei',
    name: 'Tatăl Copiilor Mei',
    subtitle: 'Oversized · diptic',
    price: 130,
    badge: 'Diptic',
    description:
      'Pentru el. Perechea lui „Mama copiilor mei”, cu același fir roșu în față și aceeași inimă pe spate. A doua jumătate a dipticului, croită ca să se asorteze pe doi umeri diferiți.',
    details: SHARED_DETAILS,
    colors: [
      { key: 'black', label: 'Negru', swatch: '#111111', front: `${IMG}/tatal-front.webp`, back: `${IMG}/tatal-back.webp` },
    ],
    sizes: SIZES,
    active: true,
    sort: 3,
  },
  {
    id: 'seed-papusa',
    slug: 'asta-e-o-papusa',
    artist: 'andrei',
    name: 'Asta e o Păpușă',
    subtitle: 'Oversized · 2 culori',
    price: 130,
    description:
      'Statement piece. „Asta este o Păpușă” în literaj de jucărie, disponibil în negru cu inimă roz neon sau în Pink Joy cu inimă alb-negru. Alege-ți culoarea și partea din tine pe care o scoți în față.',
    details: SHARED_DETAILS,
    colors: [
      { key: 'black', label: 'Negru', swatch: '#111111', front: `${IMG}/papusa-black-front.webp`, back: `${IMG}/papusa-black-back.webp` },
      { key: 'pink', label: 'Pink Joy', swatch: '#E3A0AC', front: `${IMG}/papusa-pink-front.webp`, back: `${IMG}/papusa-pink-back.webp` },
    ],
    sizes: SIZES,
    active: true,
    sort: 4,
  },
];

// === helpers ===

export function formatPrice(amount: number): string {
  return `${amount} ${CURRENCY_LABEL}`;
}

/** Price actually charged, after any per-product discount. */
export function effectivePrice(p: Product): number {
  const pct = clampPct(p.discountPercent);
  return pct > 0 ? Math.max(1, Math.round(p.price * (1 - pct / 100))) : p.price;
}
/** Original price to show struck-through, or null when no discount. */
export function compareAtPrice(p: Product): number | null {
  return clampPct(p.discountPercent) > 0 ? p.price : null;
}
export function clampPct(v: unknown): number {
  const n = Math.round(Number(v) || 0);
  return Math.min(90, Math.max(0, n));
}

/** Units available for a variant. null = not tracked (treat as unlimited). */
export function variantStock(p: Product, colorKey: string, size: SizeKey): number | null {
  if (!p.trackStock) return null;
  const color = p.colors.find((c) => c.key === colorKey) ?? p.colors[0];
  const n = color?.stock?.[size];
  return Number.isFinite(n) ? Math.max(0, Number(n)) : 0;
}
export function isVariantAvailable(p: Product, colorKey: string, size: SizeKey, qty = 1): boolean {
  const s = variantStock(p, colorKey, size);
  return s === null || s >= qty;
}
/** True when stock is tracked and every variant is out of stock. */
export function isSoldOut(p: Product): boolean {
  if (!p.trackStock) return false;
  return p.colors.every((c) => p.sizes.every((s) => (c.stock?.[s] ?? 0) <= 0));
}

/** Shipping cost (RON) for a given subtotal, per the free-over-threshold rule. */
export function shippingFor(subtotal: number): number {
  return subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FLAT;
}

/** URL-safe slug from a name (handles RO diacritics). */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Sort + filter helpers operating on a catalog array. */
export function sortProducts(list: Product[]): Product[] {
  return [...list].sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999));
}
export function activeProducts(list: Product[]): Product[] {
  return sortProducts(list.filter((p) => p.active !== false));
}
