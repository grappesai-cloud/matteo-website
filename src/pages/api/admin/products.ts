import type { APIRoute } from 'astro';
import { isAuthed } from '../../../lib/admin-auth';
import { readCatalog, writeCatalog } from '../../../lib/catalog-store';
import {
  ARTISTS, SIZES, slugify, sortProducts, clampPct, catalogArtists,
  type Product, type ProductColor, type SizeKey,
} from '../../../lib/products';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

const guard = (cookies: any) => (isAuthed(cookies) ? null : json({ error: 'Neautorizat.' }, 401));

const str = (v: unknown, max = 600) => String(v ?? '').trim().slice(0, max);

function sanitizeStock(input: any): Partial<Record<SizeKey, number>> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const out: Partial<Record<SizeKey, number>> = {};
  for (const s of SIZES) {
    const n = Math.floor(Number(input[s]));
    if (Number.isFinite(n) && n >= 0) out[s] = Math.min(99999, n);
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeColors(input: any): ProductColor[] {
  const arr = Array.isArray(input) ? input : [];
  const used = new Set<string>();
  const out: ProductColor[] = [];
  for (const c of arr) {
    const label = str(c?.label, 40) || 'Culoare';
    const front = str(c?.front, 600);
    const back = str(c?.back, 600);
    if (!front || !back) continue; // both images required
    let key = slugify(str(c?.key, 40) || label) || 'c';
    while (used.has(key)) key += '-x';
    used.add(key);
    const swatch = /^#[0-9a-fA-F]{3,8}$/.test(str(c?.swatch, 9)) ? str(c?.swatch, 9) : '#111111';
    const color: ProductColor = { key, label, swatch, front, back };
    const stock = sanitizeStock(c?.stock);
    if (stock) color.stock = stock;
    out.push(color);
  }
  return out;
}

function sanitize(input: any, existing?: Product): Product | { error: string } {
  const name = str(input?.name, 80);
  if (!name) return { error: 'Numele produsului e obligatoriu.' };

  const artistName = str(input?.artistName, 40);
  const rawArtist = str(input?.artist, 40);
  let artist = rawArtist === '__new__' ? '' : slugify(rawArtist);
  if (!artist && artistName) artist = slugify(artistName);
  if (!artist) return { error: 'Alege un artist sau scrie numele unuia nou.' };
  const isBaseArtist = ARTISTS.some((a) => a.slug === artist);

  const price = Math.round(Number(input?.price));
  if (!Number.isFinite(price) || price <= 0) return { error: 'Preț invalid.' };

  const colors = sanitizeColors(input?.colors);
  if (colors.length === 0) return { error: 'Adaugă cel puțin o culoare cu poză față și spate.' };

  const sizes = (Array.isArray(input?.sizes) ? input.sizes : SIZES)
    .map((s: any) => str(s, 4) as SizeKey)
    .filter((s: SizeKey) => SIZES.includes(s));
  if (sizes.length === 0) return { error: 'Selectează cel puțin o mărime.' };

  const details = (Array.isArray(input?.details) ? input.details : [])
    .map((d: any) => str(d, 120))
    .filter(Boolean)
    .slice(0, 12);

  return {
    id: existing?.id || `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    slug: '', // assigned by caller (uniqueness check)
    artist,
    // base artists resolve their display name from ARTISTS; only persist it for custom artists
    artistName: isBaseArtist ? undefined : (artistName || existing?.artistName || artist),
    name,
    subtitle: str(input?.subtitle, 80),
    price,
    description: str(input?.description, 1500),
    details,
    badge: str(input?.badge, 24) || undefined,
    colors,
    sizes: SIZES.filter((s) => sizes.includes(s)), // canonical order
    active: input?.active !== false,
    sort: Number.isFinite(Number(input?.sort)) ? Number(input.sort) : existing?.sort ?? 999,
    discountPercent: clampPct(input?.discountPercent),
    trackStock: !!input?.trackStock,
  };
}

function uniqueSlug(desired: string, id: string, all: Product[]): string {
  let base = slugify(desired) || 'produs';
  let slug = base;
  let n = 2;
  while (all.some((p) => p.slug === slug && p.id !== id)) slug = `${base}-${n++}`;
  return slug;
}

// LIST (all, incl inactive)
export const GET: APIRoute = async ({ cookies }) => {
  const blocked = guard(cookies);
  if (blocked) return blocked;
  const all = await readCatalog();
  return json({ products: sortProducts(all), artists: catalogArtists(all) });
};

// UPSERT
export const POST: APIRoute = async ({ request, cookies }) => {
  const blocked = guard(cookies);
  if (blocked) return blocked;

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }

  const all = await readCatalog();
  const existing = body?.id ? all.find((p) => p.id === body.id) : undefined;

  const result = sanitize(body, existing);
  if ('error' in result) return json(result, 400);

  result.slug = uniqueSlug(body?.slug || result.name, result.id, all);

  let next: Product[];
  if (existing) {
    next = all.map((p) => (p.id === result.id ? result : p));
  } else {
    if (result.sort === 999) result.sort = all.length + 1;
    next = [...all, result];
  }

  try {
    await writeCatalog(next);
  } catch (err: any) {
    return json({ error: err?.message || 'Salvarea a eșuat.' }, 500);
  }
  return json({ ok: true, product: result });
};

// DELETE { id }
export const DELETE: APIRoute = async ({ request, cookies }) => {
  const blocked = guard(cookies);
  if (blocked) return blocked;
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const id = str(body?.id, 60);
  const all = await readCatalog();
  const next = all.filter((p) => p.id !== id);
  if (next.length === all.length) return json({ error: 'Produs inexistent.' }, 404);
  try {
    await writeCatalog(next);
  } catch (err: any) {
    return json({ error: err?.message || 'Ștergerea a eșuat.' }, 500);
  }
  return json({ ok: true });
};
