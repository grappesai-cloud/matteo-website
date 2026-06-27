// === CATALOG STORE — Cloudflare R2 (JSON) ===
// The product catalog lives as a single JSON object in R2; product images live
// as individual objects. Fallbacks:
//   • local dev without R2 → a gitignored .data/catalog.json (full CRUD works)
//   • production without R2 → read-only seed (writes throw a clear error)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { seedProducts, type Product } from './products';
import { r2Configured, r2GetJson, r2PutJson, r2PutObject } from './r2';

const CATALOG_KEY = 'catalog/products.json';
const DEV = import.meta.env.DEV;
const LOCAL_FILE = path.join(process.cwd(), '.data', 'catalog.json');

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
      const data = await r2GetJson<Product[]>(CATALOG_KEY);
      if (!data) { await writeCatalog(seedProducts); return seedProducts; }
      return Array.isArray(data) && data.length ? data : seedProducts;
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

/** Overwrite the catalog. Throws if no writable backend. */
export async function writeCatalog(products: Product[]): Promise<void> {
  if (r2Configured()) { await r2PutJson(CATALOG_KEY, products); return; }
  if (DEV) { await writeLocal(products); return; }
  throw new Error('R2 nu e configurat — stocarea nu e disponibilă.');
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
