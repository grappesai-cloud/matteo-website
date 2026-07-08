// === PENDING CHECKOUT STORE (Cloudflare R2) ===
// The storefront now collects the shipping address on OUR side (before Stripe) so
// we can quote the real FAN tariff. We stash that address + the quoted shipping in
// R2 under a random token, put ONLY the token in the Stripe session metadata, and
// read it back in the webhook to build the order from OUR authoritative address
// (correct county + postal code) instead of Stripe's hosted-form address.
//
// Local dev without R2 → a gitignored .data/pending/*.json. Entries are tiny and
// effectively single-use; we don't bother garbage-collecting them.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OrderAddress } from './orders';
import { r2Configured, r2GetJson, r2PutJson } from './r2';

export interface PendingCart { slug: string; color: string; size: string; qty: number }

export interface PendingCheckout {
  token: string;
  createdAt: number;
  items: PendingCart[];
  address: OrderAddress;                       // line1/city(=locality)/state(=county)/postalCode/country
  customer: { name?: string; phone?: string; email?: string };
  shippingAmount: number;                      // RON — the FAN-quoted shipping we charged
  shippingSource: 'fan' | 'flat';              // whether the quote came from FAN or the flat fallback
}

const DEV = import.meta.env.DEV;
const keyFor = (token: string) => `checkout/pending/${token}.json`;
const localFile = (token: string) =>
  path.join(process.cwd(), '.data', 'pending', `${token.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);

export async function savePendingCheckout(pc: PendingCheckout): Promise<void> {
  if (r2Configured()) { await r2PutJson(keyFor(pc.token), pc); return; }
  if (DEV) {
    const f = localFile(pc.token);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, JSON.stringify(pc, null, 2), 'utf-8');
    return;
  }
  throw new Error('R2 nu e configurat — checkout indisponibil.');
}

export async function readPendingCheckout(token: string): Promise<PendingCheckout | null> {
  if (!token) return null;
  if (r2Configured()) return await r2GetJson<PendingCheckout>(keyFor(token));
  if (DEV) {
    try { return JSON.parse(await fs.readFile(localFile(token), 'utf-8')); } catch { return null; }
  }
  return null;
}
