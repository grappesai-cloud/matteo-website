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
import { judetFromPostalCode } from './orders';

const BASE = 'https://api.fancourier.ro';

function env(k: string): string {
  return (process.env[k] || (import.meta.env as any)[k] || '').trim();
}

export function fanConfigured(): boolean {
  return !!(env('FAN_USERNAME') && env('FAN_PASSWORD') && env('FAN_CLIENT_ID'));
}

// FAN's county/locality database is stored WITHOUT diacritics ("Arges", "Ploiesti",
// "Bucuresti"). Sending "Argeș"/"Ploiești" returns HTTP 422 "recipient.locality is
// invalid". So we strip diacritics on every county/locality we hand to FAN — for the
// tariff AND the AWB (an address typed with diacritics would otherwise fail to ship).
// NB: only for FAN — SmartBill/ANAF still get the proper diacritic county name.
function fanName(s: string): string {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
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
export function parcelWeightForUnits(units: number): number {
  return Math.max(1, Math.round((Number(units) || 0) * 0.4 * 10) / 10);
}
function estimateWeight(order: Order): number {
  const units = order.items.reduce((n, i) => n + (Number(i.qty) || 0), 0);
  return parcelWeightForUnits(units);
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
        county: fanName(judetFromPostalCode(s.postalCode) || s.state || ''),
        locality: fanName(s.city || ''),
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

// === LIVE SHIPPING QUOTE (GET /reports/awb/internal-tariff) ===
// Returns the REAL FAN tariff for a destination BEFORE an AWB exists, so the
// storefront can charge the customer exactly what the shipment will cost instead
// of a flat guess. County + locality + weight drive the price (declaredValue adds
// insurance). The endpoint is a GET whose body is a nested object serialized with
// PHP-style bracket keys (info[weight]=…&recipient[county]=…).

/** Build `a[b][c]=v` bracket query pairs from a nested plain object. */
function bracketQuery(obj: Record<string, any>, prefix = ''): string[] {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') pairs.push(...bracketQuery(v, key));
    else pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return pairs;
}

export interface FanTariff {
  total: number;     // RON, VAT included (what we charge for shipping)
  costNoVat: number; // RON without VAT
  vat: number;       // RON VAT
}

/**
 * Live FAN tariff for a Standard home delivery to (county, locality). `weight` in
 * kg, `declaredValue` in RON (insurance basis). Throws a clear RO message on failure
 * so the caller can decide to fall back to the flat rate.
 */
export async function getInternalTariff(params: {
  county: string;
  locality: string;
  weight: number;
  declaredValue?: number;
  parcels?: number;
}): Promise<FanTariff> {
  if (!fanConfigured()) throw new Error('FAN Courier nu e configurat.');
  const token = await getToken();
  const data = {
    clientId: Number(env('FAN_CLIENT_ID')),
    info: {
      service: 'Standard',
      payment: 'expeditor',
      weight: Math.max(0.1, Number(params.weight) || 1),
      packages: { parcel: Math.max(1, Number(params.parcels) || 1) },
      ...(params.declaredValue ? { declaredValue: Math.round(Number(params.declaredValue)) } : {}),
    },
    recipient: { county: fanName(params.county), locality: fanName(params.locality) },
  };
  const qs = bracketQuery(data).join('&');
  const res = await fetch(`${BASE}/reports/awb/internal-tariff?${qs}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.status === 'error') {
    const msg = body?.message || (Array.isArray(body?.errors) ? body.errors.join('; ') : '') || 'Calcul tarif FAN eșuat.';
    throw new Error(String(msg));
  }
  // The costs live under `data` (single object) — occasionally an array of one.
  const d = Array.isArray(body?.data) ? body.data[0] : (body?.data ?? body);
  const costNoVat = Number(d?.costNoVAT ?? d?.costNoVat ?? d?.cost ?? 0);
  const vat = Number(d?.vat ?? 0);
  const total = Number(d?.total ?? d?.costTotal ?? (costNoVat + vat));
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('FAN a răspuns dar fără tarif valid (verifică județ/localitate).');
  }
  return { total: Math.round(total * 100) / 100, costNoVat, vat };
}

// === GEO LOOKUPS (counties / localities / streets) — for the address form ===
// Proxied server-side (the FAN token must not reach the browser) and cached in the
// warm lambda since these lists are effectively static.

interface Cached<T> { at: number; value: T; }
const GEO_TTL = 6 * 60 * 60 * 1000; // 6h
let countiesCache: Cached<string[]> | null = null;
const localitiesCache = new Map<string, Cached<string[]>>();

async function fanGet(path: string): Promise<any> {
  if (!fanConfigured()) throw new Error('FAN Courier nu e configurat.');
  const token = await getToken();
  const res = await fetch(`${BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.status === 'error') {
    throw new Error(body?.message || `Cerere FAN eșuată (${path}).`);
  }
  return body;
}

/** All Romanian county names, sorted, cached. */
export async function listCounties(): Promise<string[]> {
  if (countiesCache && Date.now() - countiesCache.at < GEO_TTL) return countiesCache.value;
  const body = await fanGet('reports/counties');
  const value = (Array.isArray(body?.data) ? body.data : [])
    .map((c: any) => String(c?.name ?? c?.county ?? '').trim())
    .filter(Boolean)
    .sort((a: string, b: string) => a.localeCompare(b, 'ro'));
  countiesCache = { at: Date.now(), value };
  return value;
}

/** Locality names for a county, sorted, cached. */
export async function listLocalities(county: string): Promise<string[]> {
  const key = county.trim().toLowerCase();
  const hit = localitiesCache.get(key);
  if (hit && Date.now() - hit.at < GEO_TTL) return hit.value;
  const body = await fanGet(`reports/localities?county=${encodeURIComponent(county)}`);
  const value = (Array.isArray(body?.data) ? body.data : [])
    .map((c: any) => String(c?.name ?? c?.locality ?? '').trim())
    .filter(Boolean)
    .sort((a: string, b: string) => a.localeCompare(b, 'ro'));
  localitiesCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Best-effort postal-code lookup: fetch the streets of a locality and match the
 * user's street name, returning its zipCode. Cached per county+locality. Returns
 * '' when nothing matches (the customer then types it manually).
 */
const streetsCache = new Map<string, Cached<{ street: string; zip: string }[]>>();
export async function lookupZip(county: string, locality: string, street: string): Promise<string> {
  const needle = street.trim().toLowerCase();
  if (!needle) return '';
  const key = `${county.trim().toLowerCase()}|${locality.trim().toLowerCase()}`;
  let hit = streetsCache.get(key);
  if (!hit || Date.now() - hit.at >= GEO_TTL) {
    const body = await fanGet(
      `reports/streets?county=${encodeURIComponent(county)}&locality=${encodeURIComponent(locality)}&page=1&perPage=1000`,
    );
    const value = (Array.isArray(body?.data) ? body.data : []).map((s: any) => ({
      street: String(s?.street ?? '').trim(),
      zip: String(s?.details?.zipCode ?? '').trim(),
    }));
    hit = { at: Date.now(), value };
    streetsCache.set(key, hit);
  }
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const n = norm(needle);
  const exact = hit.value.find((s) => s.zip && norm(s.street) === n);
  if (exact) return exact.zip;
  const partial = hit.value.find((s) => s.zip && (norm(s.street).includes(n) || n.includes(norm(s.street))));
  return partial?.zip || '';
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

/**
 * Delete (cancel) an AWB at FAN Courier. Only works while the shipment hasn't
 * been picked up yet (same-day, before the courier scans it). Endpoint per FAN
 * API v2.0: DELETE /awb?clientId=&awb= with the Bearer token.
 */
export async function deleteAwb(awb: string): Promise<void> {
  if (!fanConfigured()) {
    throw new Error('FAN Courier nu e configurat (FAN_USERNAME / FAN_PASSWORD / FAN_CLIENT_ID).');
  }
  const clean = String(awb || '').trim();
  if (!clean) throw new Error('Lipsește numărul AWB.');
  const token = await getToken();
  const qs = new URLSearchParams({ clientId: env('FAN_CLIENT_ID'), awb: clean });
  const res = await fetch(`${BASE}/awb?${qs.toString()}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message
      || (Array.isArray(data?.errors) ? data.errors.join('; ') : '')
      || 'Ștergerea AWB FAN a eșuat (poate a fost deja preluat de curier).';
    throw new Error(msg);
  }
}
