// === ORDERS — types, status model & Stripe→Order builder ===
// Orders are persisted in Vercel Blob (see orders-store.ts) the moment a
// checkout completes. The artist admin reads them as a report; the Ruvix
// fulfillment partner reads them to print & ship (status + AWB).

import { effectivePrice, type Product, type SizeKey } from './products';

export type OrderStatus = 'new' | 'printing' | 'shipped' | 'delivered' | 'cancelled';

export const ORDER_STATUSES: OrderStatus[] = ['new', 'printing', 'shipped', 'delivered', 'cancelled'];

/** RO labels for the status badges / selects. */
export const STATUS_LABEL: Record<OrderStatus, string> = {
  new: 'Nouă',
  printing: 'În producție',
  shipped: 'Trimisă',
  delivered: 'Livrată',
  cancelled: 'Anulată',
};

export interface OrderItem {
  slug: string;
  name: string;
  artist?: string;
  color: string;        // color key
  colorLabel: string;   // RO label
  size: SizeKey | string;
  qty: number;
  unitPrice: number;    // RON, what was charged
}

export interface OrderAddress {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  postalCode?: string;
  state?: string;
  country?: string;
}

export interface Order {
  id: string;            // Stripe checkout session id (idempotency key)
  number: number;        // sequential, human-friendly (assigned on insert)
  createdAt: number;     // ms epoch
  status: OrderStatus;
  items: OrderItem[];
  amountTotal: number;   // RON (paid, incl. shipping)
  shippingAmount: number;// RON
  currency: string;
  customer: { name?: string; email?: string; phone?: string };
  shipping: OrderAddress;
  awb?: string;          // tracking number — set by Ruvix
  courier?: string;      // courier name — set by Ruvix
  invoiceSeries?: string;// SmartBill series (e.g. SHOP) — set when invoice issued
  invoiceNumber?: string;// SmartBill invoice number
  note?: string;         // internal note
  updatedAt?: number;
}

/** Total units across all line items. */
export function orderUnits(o: Order): number {
  return o.items.reduce((n, i) => n + (Number(i.qty) || 0), 0);
}

/** A one-line address string for display. */
export function formatAddress(a: OrderAddress): string {
  return [a.line1, a.line2, a.city, a.postalCode, a.state, a.country]
    .map((x) => (x || '').trim())
    .filter(Boolean)
    .join(', ');
}

type CartEntry = { s: string; c: string; z: string; q: number };

/** Read the compact cart we stashed in the Checkout Session metadata. */
function readCart(meta: Record<string, string> | null | undefined): CartEntry[] {
  try {
    const arr = JSON.parse(meta?.cart || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function pickAddress(session: any): OrderAddress {
  // Stripe has moved shipping between fields across API versions — read defensively.
  const ship =
    session?.shipping_details ||
    session?.collected_information?.shipping_details ||
    session?.shipping ||
    null;
  const addr = ship?.address || session?.customer_details?.address || {};
  return {
    name: ship?.name || session?.customer_details?.name || undefined,
    line1: addr?.line1 || undefined,
    line2: addr?.line2 || undefined,
    city: addr?.city || undefined,
    postalCode: addr?.postal_code || undefined,
    state: addr?.state || undefined,
    country: addr?.country || undefined,
  };
}

/**
 * Build an Order from a completed Stripe Checkout Session + the live catalog.
 * `number` is left at 0 — the store assigns the sequential number on insert.
 */
export function orderFromStripeSession(session: any, catalog: Product[]): Order {
  const cart = readCart(session?.metadata);
  const items: OrderItem[] = [];
  for (const entry of cart) {
    const p = catalog.find((x) => x.slug === entry.s);
    const color = p?.colors.find((c) => c.key === entry.c) ?? p?.colors[0];
    items.push({
      slug: entry.s,
      name: p?.name || entry.s,
      artist: p?.artist,
      color: color?.key || entry.c || '',
      colorLabel: color?.label || entry.c || '',
      size: entry.z,
      qty: Math.max(1, Number(entry.q) || 1),
      unitPrice: p ? effectivePrice(p) : 0,
    });
  }

  const amountTotal = Math.round((Number(session?.amount_total) || 0) / 100);
  const shippingAmount = Math.round(
    (Number(session?.total_details?.amount_shipping) || 0) / 100
  );

  return {
    id: String(session?.id || `order_${Date.now()}`),
    number: 0,
    createdAt:
      (Number(session?.created) ? Number(session.created) * 1000 : Date.now()),
    status: 'new',
    items,
    amountTotal,
    shippingAmount,
    currency: String(session?.currency || 'ron').toUpperCase(),
    customer: {
      name: session?.customer_details?.name || undefined,
      email: session?.customer_details?.email || undefined,
      phone: session?.customer_details?.phone || undefined,
    },
    shipping: pickAddress(session),
  };
}
