// === ORDERS STORE — Cloudflare R2 (JSON) ===
// All orders live in a single JSON object (low-volume merch).
// Mirrors catalog-store / landing-store. Fallbacks:
//   • local dev without R2 → a gitignored .data/orders.json
//   • production without R2 → empty list (writes throw a clear error)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Order, OrderStatus } from './orders';
import { r2Configured, r2GetJson, r2PutJson } from './r2';

const ORDERS_KEY = 'orders/orders.json';
const DEV = import.meta.env.DEV;
const LOCAL_FILE = path.join(process.cwd(), '.data', 'orders.json');

export function canWrite(): boolean {
  return r2Configured() || DEV;
}

async function readLocal(): Promise<Order[] | null> {
  try {
    const raw = await fs.readFile(LOCAL_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}
async function writeLocal(orders: Order[]): Promise<void> {
  await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
  await fs.writeFile(LOCAL_FILE, JSON.stringify(orders, null, 2), 'utf-8');
}

/** Read all orders (unsorted on disk). */
export async function readOrders(): Promise<Order[]> {
  if (r2Configured()) {
    try {
      const data = await r2GetJson<Order[]>(ORDERS_KEY);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('[orders] R2 read failed:', (err as Error)?.message);
      return [];
    }
  }
  if (DEV) return (await readLocal()) ?? [];
  return [];
}

export async function writeOrders(orders: Order[]): Promise<void> {
  if (r2Configured()) { await r2PutJson(ORDERS_KEY, orders); return; }
  if (DEV) { await writeLocal(orders); return; }
  throw new Error('R2 nu e configurat — stocarea comenzilor nu e disponibilă.');
}

/**
 * Insert an order, idempotent by id (Stripe session id). If it already exists,
 * the stored copy is kept (we never clobber fulfillment edits). Assigns the
 * next sequential `number`. Returns the persisted order + whether it was new
 * (so callers can fire a one-time notification).
 */
export async function addOrder(order: Order): Promise<{ order: Order; created: boolean }> {
  const all = await readOrders();
  const existing = all.find((o) => o.id === order.id);
  if (existing) return { order: existing, created: false };
  const maxNum = all.reduce((m, o) => Math.max(m, o.number || 0), 1000);
  const toSave: Order = { ...order, number: maxNum + 1 };
  await writeOrders([...all, toSave]);
  return { order: toSave, created: true };
}

/** Patch fulfillment fields on an order. Returns the updated order or null. */
export async function updateOrder(
  id: string,
  patch: {
    status?: OrderStatus;
    awb?: string;
    courier?: string;
    note?: string;
    invoiceSeries?: string;
    invoiceNumber?: string;
    shippedEmailAt?: number;
  }
): Promise<Order | null> {
  const all = await readOrders();
  let updated: Order | null = null;
  const next = all.map((o) => {
    if (o.id !== id) return o;
    updated = {
      ...o,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.awb !== undefined ? { awb: patch.awb } : {}),
      ...(patch.courier !== undefined ? { courier: patch.courier } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.invoiceSeries !== undefined ? { invoiceSeries: patch.invoiceSeries } : {}),
      ...(patch.invoiceNumber !== undefined ? { invoiceNumber: patch.invoiceNumber } : {}),
      ...(patch.shippedEmailAt !== undefined ? { shippedEmailAt: patch.shippedEmailAt } : {}),
      updatedAt: Date.now(),
    };
    return updated;
  });
  if (!updated) return null;
  await writeOrders(next);
  return updated;
}
