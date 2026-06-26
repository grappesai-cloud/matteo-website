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

// === COURIER PICKUP ORDER (POST /order) ===
// Schedules a courier to come collect the parcel(s). FAN rule: one courier order
// per sender branch per day covers ALL ready AWBs, so callers must debounce to a
// single pickup per day (see pickup-store + the webhook hook).

/** Romania-local parts (handles UTC server + Europe/Bucharest DST correctly). */
function roNow(): { y: number; m: number; d: number; hour: number; dow: number } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  const dows: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    hour: Number(p.hour), dow: dows[p.weekday] ?? 1,
  };
}

/**
 * Decide pickup date + a valid >=2h window based on the Romania-local clock.
 * Weekday before 15:00 → same day; otherwise the next working day (Sat/Sun roll
 * to Monday). Window stays inside the conservative 10:00–18:00 band.
 */
export function computePickupSlot(): { date: string; first: string; second: string } {
  const t = roNow();
  const pad = (n: number) => String(n).padStart(2, '0');
  let { y, m, d, dow } = t;
  const sameDay = dow >= 1 && dow <= 5 && t.hour < 15;

  if (!sameDay) {
    // advance to next working day
    const base = new Date(Date.UTC(y, m - 1, d));
    do { base.setUTCDate(base.getUTCDate() + 1); } while (base.getUTCDay() === 0 || base.getUTCDay() === 6);
    y = base.getUTCFullYear(); m = base.getUTCMonth() + 1; d = base.getUTCDate();
    return { date: `${y}-${pad(m)}-${pad(d)}`, first: '10:00', second: '16:00' };
  }
  // same-day window: start ~2h from now, clamp into 11:00–16:00, end +3h capped 18:00
  const first = Math.min(Math.max(t.hour + 2, 11), 16);
  const second = Math.min(first + 3, 18);
  return { date: `${y}-${pad(m)}-${pad(d)}`, first: `${pad(first)}:00`, second: `${pad(second)}:00` };
}

export interface FanPickupResult {
  orderId: string;
  pickupDate: string;
}

/** Place a courier pickup order for an AWB. Throws with a clear RO message on failure. */
export async function placeCourierOrder(order: Order): Promise<FanPickupResult> {
  if (!fanConfigured()) {
    throw new Error('FAN Courier nu e configurat.');
  }
  const slot = computePickupSlot();
  const token = await getToken();
  const body = {
    clientId: Number(env('FAN_CLIENT_ID')),
    info: {
      awbNumber: order.awb || null,
      packages: { parcel: 1, envelope: 0 },
      weight: estimateWeight(order),
      dimensions: { width: 30, length: 25, height: 8 },
      orderType: 'Standard',
      pickupDate: slot.date,
      pickupHours: { first: slot.first, second: slot.second },
      observations: `Comanda #${order.number}`,
    },
  };
  const res = await fetch(`${BASE}/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.status === 'error') {
    const msg = data?.message
      || (Array.isArray(data?.errors) ? data.errors.join('; ') : '')
      || 'Programarea ridicării FAN a eșuat.';
    throw new Error(String(msg));
  }
  const orderId = String(data?.data?.id ?? data?.id ?? '').trim();
  return { orderId, pickupDate: slot.date };
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
