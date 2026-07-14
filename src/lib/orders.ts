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
  confirmEmailAt?: number; // ms epoch — set once the "comandă confirmată" email is sent to the customer
  shippedEmailAt?: number; // ms epoch — set once the "comanda a fost expediată" email is sent to the customer
  returnRequestedAt?: number; // ms epoch — clientul a cerut retur prin formularul online
  refundId?: string;     // Stripe refund id — set when the order is refunded (retur)
  refundedAt?: number;   // ms epoch — when the refund was issued
  refundAmount?: number; // RON actually refunded (may be < amountTotal on partial refund)
  stornoSeries?: string; // SmartBill storno (credit-note) series
  stornoNumber?: string; // SmartBill storno (credit-note) number
}

/** Total units across all line items. */
export function orderUnits(o: Order): number {
  return o.items.reduce((n, i) => n + (Number(i.qty) || 0), 0);
}

// Prefixul de 2 cifre al codului poștal RO identifică județul (01–06 = sectoarele
// Bucureștiului). Sursă autoritară pentru județ, spre deosebire de câmpul `state`
// de la Stripe care e adesea gol. NU folosi orașul ca fallback pentru județ:
// „Vălenii de Munte" (oraș în Prahova) nu e un județ valid și ANAF respinge e-Factura.
const JUDET_BY_ZIP2: Record<string, string> = {
  '01': 'București', '02': 'București', '03': 'București',
  '04': 'București', '05': 'București', '06': 'București',
  '07': 'Ilfov', '08': 'Giurgiu',
  '10': 'Prahova', '11': 'Argeș', '12': 'Buzău', '13': 'Dâmbovița', '14': 'Teleorman',
  '20': 'Dolj', '21': 'Gorj', '22': 'Mehedinți', '23': 'Olt', '24': 'Vâlcea',
  '30': 'Timiș', '31': 'Arad', '32': 'Caraș-Severin', '33': 'Hunedoara',
  '40': 'Cluj', '41': 'Bihor', '42': 'Bistrița-Năsăud', '43': 'Maramureș',
  '44': 'Satu Mare', '45': 'Sălaj',
  '50': 'Brașov', '51': 'Alba', '52': 'Covasna', '53': 'Harghita', '54': 'Mureș', '55': 'Sibiu',
  '60': 'Bacău', '61': 'Neamț', '62': 'Vrancea',
  '70': 'Iași', '71': 'Botoșani', '72': 'Suceava', '73': 'Vaslui',
  '80': 'Galați', '81': 'Brăila', '82': 'Tulcea',
  '90': 'Constanța', '91': 'Călărași', '92': 'Ialomița',
};

/**
 * Deduce județul din codul poștal RO (primele 2 cifre). Returnează '' dacă nu se
 * poate deduce, ca apelantul să decidă fallback-ul (NICIODATĂ orașul → e-Factura invalidă).
 */
export function judetFromPostalCode(postalCode?: string): string {
  const digits = (postalCode || '').replace(/\D/g, '');
  if (digits.length < 2) return '';
  return JUDET_BY_ZIP2[digits.slice(0, 2)] || '';
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
 *
 * `override` carries the data we collected on OUR side before Stripe (address with
 * the correct county + postal code, name/phone, and the FAN-quoted shipping). When
 * present it wins over Stripe's hosted-form values; email still comes from Stripe.
 */
export function orderFromStripeSession(
  session: any,
  catalog: Product[],
  override?: {
    address?: OrderAddress;
    customer?: { name?: string; email?: string; phone?: string };
    shippingAmount?: number;
  },
): Order {
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
  const shippingAmount = override?.shippingAmount !== undefined
    ? Math.round(Number(override.shippingAmount) || 0)
    : Math.round((Number(session?.total_details?.amount_shipping) || 0) / 100);

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
      // Name/phone come from our form; email from Stripe (it collects the receipt email).
      name: override?.customer?.name || session?.customer_details?.name || undefined,
      email: session?.customer_details?.email || override?.customer?.email || undefined,
      phone: override?.customer?.phone || session?.customer_details?.phone || undefined,
    },
    shipping: override?.address || pickAddress(session),
  };
}
