// === PICKUP STATE STORE — Cloudflare R2 (JSON) ===
// Tiny single-record store that remembers the date FAN has already been asked to
// send a courier. FAN's rule is one courier order per sender branch per day, so
// the webhook debounces on this: it only places a pickup if none was placed for
// the same target pickup date. Mirrors the R2 pattern of the other stores.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { r2Configured, r2GetJson, r2PutJson } from './r2';

const PICKUP_KEY = 'pickups/last.json';
const DEV = import.meta.env.DEV;
const LOCAL_FILE = path.join(process.cwd(), '.data', 'pickup.json');

export interface PickupState {
  date: string;        // YYYY-MM-DD the courier was scheduled for
  fanOrderId?: string; // FAN's returned order id
  orderNumber?: number;
  at: number;          // epoch ms when placed
}

export async function readPickup(): Promise<PickupState | null> {
  if (r2Configured()) {
    try {
      const data = await r2GetJson<PickupState>(PICKUP_KEY);
      return data && typeof data.date === 'string' ? data : null;
    } catch (err) {
      console.error('[pickup] R2 read failed:', (err as Error)?.message);
      return null;
    }
  }
  if (DEV) {
    try { return JSON.parse(await fs.readFile(LOCAL_FILE, 'utf-8')); } catch { return null; }
  }
  return null;
}

export async function writePickup(state: PickupState): Promise<void> {
  if (r2Configured()) { await r2PutJson(PICKUP_KEY, state); return; }
  if (DEV) {
    await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
    await fs.writeFile(LOCAL_FILE, JSON.stringify(state, null, 2), 'utf-8');
  }
}
