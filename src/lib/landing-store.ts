// === LANDING STORE — Cloudflare R2 (JSON) ===
// Mirrors catalog-store: landing content lives as a single JSON object. Fallbacks:
//   • local dev without R2 → a gitignored .data/landing.json (full edit works)
//   • production without R2 → read-only seed (writes throw a clear error)
// Images are uploaded via catalog-store's uploadImage (shared /api/admin/upload).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { seedLanding, type LandingContent } from './landing';
import { r2Configured, r2GetJson, r2PutJson } from './r2';

const LANDING_KEY = 'content/landing.json';
const DEV = import.meta.env.DEV;
const LOCAL_FILE = path.join(process.cwd(), '.data', 'landing.json');

export function canWrite(): boolean {
  return r2Configured() || DEV;
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
  if (r2Configured()) {
    try {
      const data = await r2GetJson<Partial<LandingContent>>(LANDING_KEY);
      if (!data) { await writeLanding(seedLanding); return seedLanding; }
      return withDefaults(data);
    } catch (err) {
      console.error('[landing] R2 read failed, using seed:', (err as Error)?.message);
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
  if (r2Configured()) { await r2PutJson(LANDING_KEY, content); return; }
  if (DEV) { await writeLocal(content); return; }
  throw new Error('R2 nu e configurat — stocarea nu e disponibilă.');
}
