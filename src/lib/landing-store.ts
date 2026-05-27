// === LANDING STORE — Vercel Blob (JSON) ===
// Mirrors catalog-store: landing content lives as a single JSON blob. Fallbacks:
//   • local dev without Blob → a gitignored .data/landing.json (full edit works)
//   • production without Blob → read-only seed (writes throw a clear error)
// Images are uploaded via catalog-store's uploadImage (shared /api/admin/upload).

import { list, put } from '@vercel/blob';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { seedLanding, type LandingContent } from './landing';

const LANDING_PATH = 'content/landing.json';
const DEV = import.meta.env.DEV;
const LOCAL_FILE = path.join(process.cwd(), '.data', 'landing.json');

function token(): string | undefined {
  return process.env.BLOB_READ_WRITE_TOKEN || import.meta.env.BLOB_READ_WRITE_TOKEN;
}
export function hasBlob(): boolean {
  return !!token();
}
/** True when content can actually be written (Blob configured, or local dev). */
export function canWrite(): boolean {
  return hasBlob() || DEV;
}

/** Merge stored content over the seed so newly-added fields keep a sane default. */
function withDefaults(data: Partial<LandingContent> | null | undefined): LandingContent {
  if (!data || typeof data !== 'object') return seedLanding;
  return {
    headerSub: typeof data.headerSub === 'string' ? data.headerSub : seedLanding.headerSub,
    footerEmail: typeof data.footerEmail === 'string' ? data.footerEmail : seedLanding.footerEmail,
    roster: Array.isArray(data.roster) && data.roster.length ? data.roster : seedLanding.roster,
    tiles: Array.isArray(data.tiles) && data.tiles.length ? data.tiles : seedLanding.tiles,
  };
}

async function readLocal(): Promise<LandingContent | null> {
  try {
    const raw = await fs.readFile(LOCAL_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function writeLocal(content: LandingContent): Promise<void> {
  await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
  await fs.writeFile(LOCAL_FILE, JSON.stringify(content, null, 2), 'utf-8');
}

/** Read the live landing content. Falls back to local file (dev) / seed. */
export async function readLanding(): Promise<LandingContent> {
  if (hasBlob()) {
    try {
      const { blobs } = await list({ prefix: LANDING_PATH, limit: 1, token: token() });
      if (!blobs.length) { await writeLanding(seedLanding); return seedLanding; }
      const res = await fetch(blobs[0].url, { cache: 'no-store' });
      if (!res.ok) return seedLanding;
      return withDefaults(await res.json());
    } catch (err) {
      console.error('[landing] blob read failed, using seed:', (err as Error)?.message);
      return seedLanding;
    }
  }
  if (DEV) {
    const local = await readLocal();
    if (local) return withDefaults(local);
    await writeLocal(seedLanding);
    return seedLanding;
  }
  return seedLanding;
}

/** Overwrite the landing content. Throws if no writable backend. */
export async function writeLanding(content: LandingContent): Promise<void> {
  if (hasBlob()) {
    await put(LANDING_PATH, JSON.stringify(content, null, 2), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
      token: token(),
    });
    return;
  }
  if (DEV) { await writeLocal(content); return; }
  throw new Error('BLOB_READ_WRITE_TOKEN lipsește — stocarea nu e configurată.');
}
