// === FAN COURIER — Self-AWB API v2.0 (api.fancourier.ro) ===
// Env-gated: when FAN_USERNAME / FAN_PASSWORD / FAN_CLIENT_ID are all set, the
// Ruvix dashboard can generate an AWB straight from an order's shipping address.
// Without them, fanConfigured() is false and the API returns a clear message.
//
// Flow: POST /login → Bearer token (cached ~23h) → POST /intern-awb with the
// recipient + package details → parse the returned AWB number.
//
// NOTE: the exact intern-awb payload field names follow FAN's v2.0 docs. If your
// account/contract expects different keys (e.g. a specific service name), this is
// the single place to adjust — see buildShipment() below.

import type { Order } from './orders';

const BASE = 'https://api.fancourier.ro';

function env(k: string): string {
  return (process.env[k] || (import.meta.env as any)[k] || '').trim();
}

export function fanConfigured(): boolean {
  return !!(env('FAN_USERNAME') && env('FAN_PASSWORD') && env('FAN_CLIENT_ID'));
}

/** Public tracking URL for an AWB (works regardless of API config). */
export function fanTrackingUrl(awb: string): string {
  return `https://www.fancourier.ro/awb-tracking/?awb=${encodeURIComponent(awb)}`;
}

// --- token cache (per warm lambda instance) ---
let cachedToken = '';
let cachedAt = 0;
const TOKEN_TTL = 23 * 60 * 60 * 1000; // 23h

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() - cachedAt < TOKEN_TTL) return cachedToken;
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env('FAN_USERNAME'), password: env('FAN_PASSWORD') }),
  });
  const data = await res.json().catch(() => ({}));
  const token = data?.data?.token || data?.token;
  if (!res.ok || !token) {
    throw new Error(data?.message || 'Autentificare FAN Courier eșuată (verifică user/parolă).');
  }
  cachedToken = token;
  cachedAt = Date.now();
  return token;
}

/** Rough parcel weight: ~0.4 kg per t-shirt, min 1 kg. */
function estimateWeight(order: Order): number {
  const units = order.items.reduce((n, i) => n + (Number(i.qty) || 0), 0);
  return Math.max(1, Math.round(units * 0.4 * 10) / 10);
}

function buildShipment(order: Order) {
  const s = order.shipping || {};
  const content = order.items.map((i) => `${i.qty}x ${i.name} (${i.size})`).join(', ').slice(0, 250);
  return {
    info: {
      service: 'Standard',
      packages: { parcel: 1, envelope: 0 },
      weight: estimateWeight(order),
      payment: 'expeditor', // shipping paid by sender — customer already paid online
      cod: 0,               // not cash-on-delivery (paid via Stripe)
      declaredValue: order.amountTotal || 0,
      content: content || 'Tricouri',
      observation: `Comanda #${order.number}`,
    },
    recipient: {
      name: order.customer?.name || s.name || 'Client',
      contactPerson: order.customer?.name || s.name || '',
      phone: order.customer?.phone || '',
      email: order.customer?.email || '',
      address: {
        county: s.state || s.city || '',
        locality: s.city || '',
        street: [s.line1, s.line2].filter(Boolean).join(', '),
        number: '',
        zipCode: s.postalCode || '',
      },
    },
  };
}

export interface FanAwbResult {
  awb: string;
  cost?: number;
}

/**
 * Generate an internal AWB for an order. Throws with a clear RO message on failure.
 * FAN returns HTTP 200 with a per-shipment result array under `response` (older
 * payloads used `data`), each item: { awbNumber, success, errors, cost }.
 */
export async function createAwb(order: Order): Promise<FanAwbResult> {
  if (!fanConfigured()) {
    throw new Error('FAN Courier nu e configurat (FAN_USERNAME / FAN_PASSWORD / FAN_CLIENT_ID).');
  }
  const token = await getToken();
  const res = await fetch(`${BASE}/intern-awb`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ clientId: Number(env('FAN_CLIENT_ID')), shipments: [buildShipment(order)] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || (Array.isArray(data?.errors) ? data.errors.join('; ') : '') || 'Generarea AWB FAN a eșuat.';
    throw new Error(msg);
  }
  // Per-shipment result lives under `response` (or `data` on older payloads).
  const list = Array.isArray(data?.response) ? data.response
             : Array.isArray(data?.data) ? data.data : [];
  const first = list[0] ?? data?.response ?? data?.data ?? {};
  if (first?.success === false) {
    const errs = Array.isArray(first.errors) ? first.errors.join('; ') : (first.errors || first.message);
    throw new Error(String(errs || 'FAN a respins comanda — verifică adresa de livrare (județ/oraș/stradă/cod poștal).'));
  }
  const awb = String(first?.awbNumber || first?.awb || '').trim();
  if (!awb) throw new Error('FAN a răspuns dar fără număr AWB — verifică datele de livrare ale comenzii.');
  const cost = Number(first?.cost ?? first?.tariff);
  return { awb, cost: Number.isFinite(cost) ? cost : undefined };
}
