// === CATALOG STORE — Cloudflare R2 (JSON) ===
// The product catalog lives as a single JSON object in R2; product images live
// as individual objects. Fallbacks:
//   • local dev without R2 → a gitignored .data/catalog.json (full CRUD works)
//   • production without R2 → read-only seed (writes throw a clear error)
//
// Orice modificare trece prin `mutateCatalog` = citire cu ETag → modificare →
// scriere condiționată (If-Match) → reîncercare la conflict (aceeași schemă ca
// mutateOrders din orders-store.ts). Fără asta, două plăți simultane pierdeau
// scăderi, iar o salvare din admin putea șterge o scădere făcută de webhook
// între timp (ambele reproduse pe 12-10-2026). Formatul stocat rămâne lista de
// produse (rezervările de stoc stau pe produs, vezi lib/stock-ledger.ts).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { seedProducts, type Product } from './products';
import { r2Configured, r2GetJsonMeta, r2PutJson, r2PutJsonConditional, r2PutObject, R2PreconditionFailed } from './r2';

const CATALOG_KEY = 'catalog/products.json';
const DEV = import.meta.env.DEV;
const LOCAL_FILE = path.join(process.cwd(), '.data', 'catalog.json');
const MAX_RETRIES = 8;

export function hasStore(): boolean {
  return r2Configured();
}
/** True when products can actually be written (R2 configured, or local dev). */
export function canWrite(): boolean {
  return r2Configured() || DEV;
}

// --- local file fallback (dev only) ---
async function readLocal(): Promise<Product[] | null> {
  try {
    const raw = await fs.readFile(LOCAL_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}
async function writeLocal(products: Product[]): Promise<void> {
  await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
  await fs.writeFile(LOCAL_FILE, JSON.stringify(products, null, 2), 'utf-8');
}

/** Read the live catalog. Falls back to local file (dev) / seed. */
export async function readCatalog(): Promise<Product[]> {
  if (r2Configured()) {
    try {
      const { value } = await r2GetJsonMeta<Product[]>(CATALOG_KEY);
      if (!value) { await r2PutJson(CATALOG_KEY, seedProducts); return seedProducts; }
      return Array.isArray(value) && value.length ? value : seedProducts;
    } catch (err) {
      console.error('[catalog] R2 read failed, using seed:', (err as Error)?.message);
      return seedProducts;
    }
  }
  if (DEV) {
    const local = await readLocal();
    if (local) return local;
    await writeLocal(seedProducts);
    return seedProducts;
  }
  return seedProducts;
}

/**
 * Citire-modificare-scriere ATOMICĂ pe tot catalogul. `mutate` primește lista
 * curentă (o modifică în loc, sau întoarce prin `replace` o listă nouă) și dă
 * înapoi un rezultat pentru apelant. Dacă obiectul s-a schimbat între citire și
 * scriere, recitim și reaplicăm `mutate` pe starea nouă, de cel mult MAX_RETRIES ori.
 */
export async function mutateCatalog<R>(
  mutate: (products: Product[], replace: (next: Product[]) => void) => R,
): Promise<R> {
  const run = (products: Product[]) => {
    let next = products;
    const result = mutate(products, (n) => { next = n; });
    return { next, result };
  };
  if (!r2Configured()) {
    if (!DEV) throw new Error('R2 nu e configurat — stocarea nu e disponibilă.');
    const { next, result } = run((await readLocal()) ?? structuredClone(seedProducts));
    await writeLocal(next);
    return result;
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { value, etag } = await r2GetJsonMeta<Product[]>(CATALOG_KEY);
    const current = Array.isArray(value) && value.length ? value : structuredClone(seedProducts);
    const { next, result } = run(current);
    try {
      await r2PutJsonConditional(CATALOG_KEY, next, etag);
      return result;
    } catch (err) {
      if (err instanceof R2PreconditionFailed) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 40 + attempt * 40));
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `Salvarea catalogului a eșuat după ${MAX_RETRIES} încercări (scrieri concurente). ${(lastErr as Error)?.message || ''}`,
  );
}

/**
 * Înlocuiește toată lista de produse. Folosit doar acolo unde chiar vrem să
 * suprascriem tot; scăderile de stoc trec prin mutateCatalog + stock-ledger.
 */
export async function writeCatalog(products: Product[]): Promise<void> {
  await mutateCatalog((_cur, replace) => { replace(products); });
}

/** Upload a product image, return its public URL. */
export async function uploadImage(filename: string, body: Blob | ArrayBuffer | Buffer, contentType?: string): Promise<string> {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-80);
  const rand = Math.random().toString(36).slice(2, 10);
  const key = `merch/${Date.now()}-${rand}-${safe}`;
  const buf =
    body instanceof Buffer ? body
    : body instanceof ArrayBuffer ? Buffer.from(body)
    : Buffer.from(await (body as Blob).arrayBuffer());

  if (r2Configured()) return r2PutObject(key, buf, contentType);

  if (DEV) {
    // dev fallback: save under public/images/merch/uploads so the URL is servable
    const dir = path.join(process.cwd(), 'public', 'images', 'merch', 'uploads');
    await fs.mkdir(dir, { recursive: true });
    const fname = `${Date.now()}-${rand}-${safe}`;
    await fs.writeFile(path.join(dir, fname), buf);
    return `/images/merch/uploads/${fname}`;
  }
  throw new Error('R2 nu e configurat — upload indisponibil.');
}

export async function findBySlug(slug: string): Promise<Product | undefined> {
  const all = await readCatalog();
  return all.find((p) => p.slug === slug);
}
