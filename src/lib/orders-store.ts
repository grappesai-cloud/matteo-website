// === ORDERS STORE — Vercel Blob (JSON) ===
// All orders live in a single JSON blob (newest concerns are low-volume merch).
// Mirrors catalog-store / landing-store. Fallbacks:
//   • local dev without Blob → a gitignored .data/orders.json
//   • production without Blob → empty list (writes throw a clear error)

import { list, put } from '@vercel/blob';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Order, OrderStatus } from './orders';

const ORDERS_PATH = 'orders/orders.json';
const DEV = import.meta.env.DEV;
const LOCAL_FILE = path.join(process.cwd(), '.data', 'orders.json');

function token(): string | undefined {
  return process.env.BLOB_READ_WRITE_TOKEN || import.meta.env.BLOB_READ_WRITE_TOKEN;
}
export function hasBlob(): boolean {
  return !!token();
}
export function canWrite(): boolean {
  return hasBlob() || DEV;
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
  if (hasBlob()) {
    try {
      const { blobs } = await list({ prefix: ORDERS_PATH, limit: 1, token: token() });
      if (!blobs.length) return [];
      const res = await fetch(blobs[0].url, { cache: 'no-store' });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? (data as Order[]) : [];
    } catch (err) {
      console.error('[orders] blob read failed:', (err as Error)?.message);
      return [];
    }
  }
  if (DEV) return (await readLocal()) ?? [];
  return [];
}

export async function writeOrders(orders: Order[]): Promise<void> {
  if (hasBlob()) {
    await put(ORDERS_PATH, JSON.stringify(orders, null, 2), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
      token: token(),
    });
    return;
  }
  if (DEV) { await writeLocal(orders); return; }
  throw new Error('BLOB_READ_WRITE_TOKEN lipsește — stocarea comenzilor nu e configurată.');
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
  patch: { status?: OrderStatus; awb?: string; courier?: string; note?: string }
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
      updatedAt: Date.now(),
    };
    return updated;
  });
  if (!updated) return null;
  await writeOrders(next);
  return updated;
}
