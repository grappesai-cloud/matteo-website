// === SMARTBILL — facturare automată (SmartBill Cloud API) ===
// Env-gated: când SMARTBILL_USER / SMARTBILL_TOKEN / SMARTBILL_CIF / SMARTBILL_SERIES
// sunt setate, la fiecare comandă plătită se emite automat o factură fiscală.
// Fără ele, smartbillConfigured() e false și pasul se sare curat.
//
// Endpoint: POST https://ws.smartbill.ro/SBORO/api/invoice (Basic auth user:token).
// B2C, prețuri cu TVA inclus (isTaxIncluded), cotă 21% „Normala". Transportul intră
// ca linie separată de tip serviciu.
//
// ⚠ GOTCHA: `sendEmail:true` face SmartBill să RESPINGĂ toată factura cu 400
// „Server-ul de email nu a fost configurat." dacă nu ai SMTP setat în contul
// SmartBill (Setări → Configurare → Email). De aceea sendEmail e gated separat pe
// SMARTBILL_SEND_EMAIL==='true', default OFF — factura se emite mereu; emailul către
// client se activează doar după ce configurezi SMTP în SmartBill.

import type { Order } from './orders';
import { judetFromPostalCode } from './orders';
import { ADULT_SIZES } from './products';

const BASE = 'https://ws.smartbill.ro/SBORO/api';

// Denumiri generice de produs pe factură. Ilinca primește de la Ruvix doar 3 SKU-uri
// generice — TRICOU ADULTI / TRICOU COPIL / PUNGA — indiferent de model/culoare, deci
// factura folosește aceleași denumiri, iar modelul concret merge în descriere.
// DESCĂRCARE DE GESTIUNE (useStock): gated pe env. Default OPRIT — stocul e gestionat
// în app. Se activează setând SMARTBILL_USE_STOCK=true + SMARTBILL_WAREHOUSE=<numele
// gestiunii>. ⚠ Ca să nu spargă facturarea (cum a făcut prima dată), articolele generice
// TRICOU ADULTI / TRICOU COPIL / TRANSPORT trebuie să existe în Nomenclatorul SmartBill
// (unitate „buc") și gestiunea să aibă stoc pe ele; altfel SmartBill respinge factura.
function useStockEnabled(): boolean {
  return env('SMARTBILL_USE_STOCK') === 'true' && !!env('SMARTBILL_WAREHOUSE');
}
function gestiuneName(size: string): string {
  const s = String(size || '').trim();
  const isKid = !!s && !(ADULT_SIZES as readonly string[]).includes(s);
  return isKid
    ? (env('SMARTBILL_NAME_KID') || 'TRICOU COPIL')
    : (env('SMARTBILL_NAME_ADULT') || 'TRICOU ADULTI');
}

function env(k: string): string {
  return (process.env[k] || (import.meta.env as any)[k] || '').trim();
}

export function smartbillConfigured(): boolean {
  return !!(env('SMARTBILL_USER') && env('SMARTBILL_TOKEN') && env('SMARTBILL_CIF') && env('SMARTBILL_SERIES'));
}

const TVA = 21; // cota standard RO (2025+)

function todayISO(): string {
  // Bucharest is UTC+2/+3; a plain ISO date is fine for the invoice issue date.
  return new Date().toISOString().slice(0, 10);
}

/** Opțiuni de emitere. Implicit: data de azi, email conform SMARTBILL_SEND_EMAIL. */
export interface IssueOptions {
  issueDate?: string; // ISO YYYY-MM-DD; override pentru emitere retroactivă
  sendEmail?: boolean; // override peste flag-ul din env
}

function buildInvoice(order: Order, opts: IssueOptions = {}) {
  const s = order.shipping || {};
  const cif = env('SMARTBILL_CIF');
  const issueDate = opts.issueDate || todayISO();
  const sendEmail = opts.sendEmail ?? env('SMARTBILL_SEND_EMAIL') === 'true';

  const products = order.items.map((i) => {
    // Modelul concret + mărime + culoare merg în DESCRIERE (apare sub denumire pe
    // factură ca „opțiune"), iar denumirea rămâne generică ca să se potrivească cu
    // gestiunea și să se facă scăderea automată.
    const optiune = [i.name, i.size, i.colorLabel].map((x) => String(x || '').trim()).filter(Boolean).join(' · ');
    return {
      name: gestiuneName(i.size),          // ex. „TRICOU ADULTI" — identic cu gestiunea
      productDescription: optiune,         // ex. „Asta e o Păpușă · M · Negru"
      measuringUnitName: 'buc',
      currency: order.currency || 'RON',
      quantity: Number(i.qty) || 1,
      price: Number(i.unitPrice) || 0, // preț unitar CU TVA inclus
      isTaxIncluded: true,
      taxName: 'Normala',
      taxPercentage: TVA,
      saveToDb: false,
      isService: false,
    };
  });

  // Cartolina inclusă în fiecare colet: linie de produs cu valoare 0, ca ieșirea
  // din stoc să aibă document fiscal și să se poată scădea pe consum la contabilitate.
  // Oprire rapidă (fără deploy de cod) cu SMARTBILL_CARTOLINA=false; denumirea
  // trebuie să rămână identică cu articolul din Nomenclator dacă se activează useStock.
  if (env('SMARTBILL_CARTOLINA') !== 'false') {
    products.push({
      name: env('SMARTBILL_NAME_CARTOLINA') || 'CARTOLINA',
      productDescription: '',
      measuringUnitName: 'buc',
      currency: order.currency || 'RON',
      quantity: 1,
      price: 0,
      isTaxIncluded: true,
      taxName: 'Normala',
      taxPercentage: TVA,
      saveToDb: false,
      isService: false,
    });
  }

  // Transportul ca linie de serviciu (dacă a fost taxat).
  if (Number(order.shippingAmount) > 0) {
    products.push({
      name: 'Transport',
      productDescription: '',
      measuringUnitName: 'buc',
      currency: order.currency || 'RON',
      quantity: 1,
      price: Number(order.shippingAmount) || 0,
      isTaxIncluded: true,
      taxName: 'Normala',
      taxPercentage: TVA,
      saveToDb: false,
      isService: true,
    });
  }

  return {
    companyVatCode: cif,
    client: {
      name: order.customer?.name || s.name || 'Client',
      vatCode: '',
      isTaxPayer: false,
      address: [s.line1, s.line2].filter(Boolean).join(', '),
      city: s.city || '',
      // Județul dedus din codul poștal (autoritar); `state` doar fallback fiindcă
      // Stripe pune adesea ORAȘUL în `state` la checkout-ul lor hosted.
      county: judetFromPostalCode(s.postalCode) || s.state || '',
      country: s.country || 'Romania',
      email: order.customer?.email || '',
      saveToDb: false,
    },
    issueDate,
    seriesName: env('SMARTBILL_SERIES'),
    isDraft: false,
    dueDate: issueDate,
    mentions: `Comanda #${order.number}`,
    observations: `Comanda online #${order.number}`,
    // Descărcare de gestiune: doar dacă SMARTBILL_USE_STOCK=true + gestiune setată.
    useStock: useStockEnabled(),
    ...(useStockEnabled() ? { warehouseName: env('SMARTBILL_WAREHOUSE') } : {}),
    sendEmail,
    products,
  };
}

export interface SmartbillInvoice {
  series: string;
  number: string;
}

/**
 * Emite o factură pentru o comandă. Aruncă o eroare RO clară la eșec.
 * Răspuns SmartBill: { errorText, message, series, number } — număr gol/eroare ⇒ throw.
 */
export async function issueInvoice(order: Order, opts: IssueOptions = {}): Promise<SmartbillInvoice> {
  const auth = Buffer.from(`${env('SMARTBILL_USER')}:${env('SMARTBILL_TOKEN')}`).toString('base64');
  const res = await fetch(`${BASE}/invoice`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(buildInvoice(order, opts)),
  });

  const data = await res.json().catch(() => ({} as any));
  if (!res.ok || data?.errorText || !data?.number) {
    // SmartBill întoarce fie `errorText` (format vechi), fie `errors[].message` (nou).
    const detail = data?.errorText || data?.message || data?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(`Emitere factură SmartBill eșuată: ${detail}`);
  }
  return { series: String(data.series || env('SMARTBILL_SERIES')), number: String(data.number) };
}

/**
 * Interoghează gestiunile și stocul din SmartBill (endpoint GET /SBORO/api/stocks).
 * Fără warehouseName întoarce toate gestiunile. Util ca să verificăm ce gestiuni și
 * ce articole există în cont ÎNAINTE de a activa useStock (denumirile trebuie să fie
 * identice cu cele trimise pe factură). Returnează răspunsul brut SmartBill.
 */
export async function listStocks(warehouseName?: string): Promise<any> {
  const cif = env('SMARTBILL_CIF');
  const auth = Buffer.from(`${env('SMARTBILL_USER')}:${env('SMARTBILL_TOKEN')}`).toString('base64');
  const params = new URLSearchParams({ cif, date: todayISO() });
  if (warehouseName) params.set('warehouseName', warehouseName);
  const res = await fetch(`${BASE}/stocks?${params.toString()}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok || data?.errorText) {
    const detail = data?.errorText || data?.message || `HTTP ${res.status}`;
    throw new Error(`Interogare stoc SmartBill eșuată: ${detail}`);
  }
  return data;
}

/**
 * Stornează o factură emisă (emite o factură storno care o anulează fiscal).
 * Endpoint SmartBill: POST /SBORO/api/invoice/reverse cu {companyVatCode, seriesName,
 * number, issueDate}. Dacă factura originală a fost trimisă în SPV (e-Factura), storno
 * se trimite automat de SmartBill în SPV conform setărilor contului.
 *
 * Aruncă o eroare RO clară la eșec. Returnează seria/numărul stornării dacă API-ul le dă.
 */
export async function reverseInvoice(series: string, number: string): Promise<SmartbillInvoice> {
  const auth = Buffer.from(`${env('SMARTBILL_USER')}:${env('SMARTBILL_TOKEN')}`).toString('base64');
  const res = await fetch(`${BASE}/invoice/reverse`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      companyVatCode: env('SMARTBILL_CIF'),
      seriesName: series,
      number: String(number),
      issueDate: todayISO(),
    }),
  });

  const data = await res.json().catch(() => ({} as any));
  if (!res.ok || data?.errorText) {
    throw new Error(data?.errorText || data?.message || `Stornare factură SmartBill eșuată (HTTP ${res.status}).`);
  }
  // Reverse-ul poate întoarce seria/numărul documentului storno; dacă nu, marcăm doar succesul.
  return { series: String(data?.series || series), number: String(data?.number || '') };
}
