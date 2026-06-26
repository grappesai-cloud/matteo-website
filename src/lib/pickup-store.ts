// === PICKUP STATE STORE — Vercel Blob (JSON) ===
// Tiny single-record store that remembers the date FAN has already been asked to
// send a courier. FAN's rule is one courier order per sender branch per day, so
// the webhook debounces on this: it only places a pickup if none was placed for
// the same target pickup date. Mirrors the Blob pattern of the other stores.

import { list, put } from '@vercel/blob';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const PICKUP_PATH = 'pickups/last.json';
const DEV = import.meta.env.DEV;
const LOCAL_FILE = path.join(process.cwd(), '.data', 'pickup.json');

export interface PickupState {
  date: string;        // YYYY-MM-DD the courier was scheduled for
  fanOrderId?: string; // FAN's returned order id
  orderNumber?: number;
  at: number;          // epoch ms when placed
}

function token(): string | undefined {
  return process.env.BLOB_READ_WRITE_TOKEN || import.meta.env.BLOB_READ_WRITE_TOKEN;
}
function hasBlob(): boolean {
  return !!token();
}

export async function readPickup(): Promise<PickupState | null> {
  if (hasBlob()) {
    try {
      const { blobs } = await list({ prefix: PICKUP_PATH, limit: 1, token: token() });
      if (!blobs.length) return null;
      const res = await fetch(blobs[0].url, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data.date === 'string' ? (data as PickupState) : null;
    } catch (err) {
      console.error('[pickup] blob read failed:', (err as Error)?.message);
      return null;
    }
  }
  if (DEV) {
    try { return JSON.parse(await fs.readFile(LOCAL_FILE, 'utf-8')); } catch { return null; }
  }
  return null;
}

export async function writePickup(state: PickupState): Promise<void> {
  if (hasBlob()) {
    await put(PICKUP_PATH, JSON.stringify(state, null, 2), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
      token: token(),
    });
    return;
  }
  if (DEV) {
    await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
    await fs.writeFile(LOCAL_FILE, JSON.stringify(state, null, 2), 'utf-8');
  }
}
