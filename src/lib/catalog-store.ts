// === CATALOG STORE — Vercel Blob (JSON) ===
// The product catalog lives as a single JSON blob; product images live as
// individual blobs. Fallbacks:
//   • local dev without Blob → a gitignored .data/catalog.json (full CRUD works)
//   • production without Blob → read-only seed (writes throw a clear error)

import { list, put } from '@vercel/blob';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { seedProducts, type Product } from './products';

const CATALOG_PATH = 'catalog/products.json';
const DEV = import.meta.env.DEV;
const LOCAL_FILE = path.join(process.cwd(), '.data', 'catalog.json');

function token(): string | undefined {
  return process.env.BLOB_READ_WRITE_TOKEN || import.meta.env.BLOB_READ_WRITE_TOKEN;
}
export function hasBlob(): boolean {
  return !!token();
}
/** True when products can actually be written (Blob configured, or local dev). */
export function canWrite(): boolean {
  return hasBlob() || DEV;
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
  if (hasBlob()) {
    try {
      const { blobs } = await list({ prefix: CATALOG_PATH, limit: 1, token: token() });
      if (!blobs.length) { await writeCatalog(seedProducts); return seedProducts; }
      const res = await fetch(blobs[0].url, { cache: 'no-store' });
      if (!res.ok) return seedProducts;
      const data = await res.json();
      return Array.isArray(data) && data.length ? (data as Product[]) : seedProducts;
    } catch (err) {
      console.error('[catalog] blob read failed, using seed:', (err as Error)?.message);
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
  if (hasBlob()) {
    await put(CATALOG_PATH, JSON.stringify(products, null, 2), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
      token: token(),
    });
    return;
  }
  if (DEV) { await writeLocal(products); return; }
  throw new Error('BLOB_READ_WRITE_TOKEN lipsește — stocarea nu e configurată.');
}

/** Upload a product image, return its public URL. */
export async function uploadImage(filename: string, body: Blob | ArrayBuffer | Buffer, contentType?: string): Promise<string> {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-80);
  if (hasBlob()) {
    const res = await put(`merch/${Date.now()}-${safe}`, body as any, {
      access: 'public',
      addRandomSuffix: true,
      contentType,
      token: token(),
    });
    return res.url;
  }
  if (DEV) {
    // dev fallback: save under public/images/merch/uploads so the URL is servable
    const dir = path.join(process.cwd(), 'public', 'images', 'merch', 'uploads');
    await fs.mkdir(dir, { recursive: true });
    const fname = `${Date.now()}-${safe}`;
    const buf = body instanceof Buffer ? body : Buffer.from(await (body as Blob).arrayBuffer());
    await fs.writeFile(path.join(dir, fname), buf);
    return `/images/merch/uploads/${fname}`;
  }
  throw new Error('BLOB_READ_WRITE_TOKEN lipsește — upload indisponibil.');
}

export async function findBySlug(slug: string): Promise<Product | undefined> {
  const all = await readCatalog();
  return all.find((p) => p.slug === slug);
}
