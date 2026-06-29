// === ARTIST META STORE — Cloudflare R2 (JSON) ===
// Artists in the merch catalog are derived from the products themselves, so they
// have no first-class record. This tiny side-store keeps the bits that aren't
// derivable from products: the display ORDER of the artist tabs and which
// artists are HIDDEN (so a base artist that's been deleted doesn't reappear as
// an empty tab). Same fallback strategy as catalog-store.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { r2Configured, r2GetJson, r2PutJson } from './r2';

export interface ArtistMeta {
  /** Slugs in the desired display order. Slugs not listed fall back after. */
  order: string[];
  /** Slugs that should never be shown (deleted base artists). */
  hidden: string[];
}

const META_KEY = 'catalog/artist-meta.json';
const DEV = import.meta.env.DEV;
const LOCAL_FILE = path.join(process.cwd(), '.data', 'artist-meta.json');

const EMPTY: ArtistMeta = { order: [], hidden: [] };

function normalize(data: any): ArtistMeta {
  return {
    order: Array.isArray(data?.order) ? data.order.map(String) : [],
    hidden: Array.isArray(data?.hidden) ? data.hidden.map(String) : [],
  };
}

export async function readArtistMeta(): Promise<ArtistMeta> {
  if (r2Configured()) {
    try {
      const data = await r2GetJson<ArtistMeta>(META_KEY);
      return data ? normalize(data) : { ...EMPTY };
    } catch (err) {
      console.error('[artist-meta] R2 read failed:', (err as Error)?.message);
      return { ...EMPTY };
    }
  }
  if (DEV) {
    try {
      return normalize(JSON.parse(await fs.readFile(LOCAL_FILE, 'utf-8')));
    } catch {
      return { ...EMPTY };
    }
  }
  return { ...EMPTY };
}

export async function writeArtistMeta(meta: ArtistMeta): Promise<void> {
  const clean = normalize(meta);
  if (r2Configured()) { await r2PutJson(META_KEY, clean); return; }
  if (DEV) {
    await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
    await fs.writeFile(LOCAL_FILE, JSON.stringify(clean, null, 2), 'utf-8');
    return;
  }
  throw new Error('R2 nu e configurat — stocarea nu e disponibilă.');
}
