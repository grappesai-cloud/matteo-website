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

const BASE = 'https://ws.smartbill.ro/SBORO/api';

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

function buildInvoice(order: Order) {
  const s = order.shipping || {};
  const cif = env('SMARTBILL_CIF');

  const products = order.items.map((i) => ({
    name: `${i.name}${i.size ? ` (${i.size}${i.colorLabel ? `, ${i.colorLabel}` : ''})` : ''}`,
    measuringUnitName: 'buc',
    currency: order.currency || 'RON',
    quantity: Number(i.qty) || 1,
    price: Number(i.unitPrice) || 0, // preț unitar CU TVA inclus
    isTaxIncluded: true,
    taxName: 'Normala',
    taxPercentage: TVA,
    saveToDb: false,
    isService: false,
  }));

  // Transportul ca linie de serviciu (dacă a fost taxat).
  if (Number(order.shippingAmount) > 0) {
    products.push({
      name: 'Transport',
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
      // Județul din cod poștal (autoritar). NU folosi orașul ca fallback:
      // „Vălenii de Munte" nu e județ valid și ANAF respinge e-Factura.
      county: judetFromPostalCode(s.postalCode) || s.state || '',
      country: s.country || 'Romania',
      email: order.customer?.email || '',
      saveToDb: false,
    },
    issueDate: todayISO(),
    seriesName: env('SMARTBILL_SERIES'),
    isDraft: false,
    dueDate: todayISO(),
    mentions: `Comanda #${order.number}`,
    observations: `Comanda online #${order.number}`,
    useStock: false,
    sendEmail: env('SMARTBILL_SEND_EMAIL') === 'true',
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
export async function issueInvoice(order: Order): Promise<SmartbillInvoice> {
  const auth = Buffer.from(`${env('SMARTBILL_USER')}:${env('SMARTBILL_TOKEN')}`).toString('base64');
  const res = await fetch(`${BASE}/invoice`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(buildInvoice(order)),
  });

  const data = await res.json().catch(() => ({} as any));
  if (!res.ok || data?.errorText || !data?.number) {
    throw new Error(data?.errorText || data?.message || `Emitere factură SmartBill eșuată (HTTP ${res.status}).`);
  }
  return { series: String(data.series || env('SMARTBILL_SERIES')), number: String(data.number) };
}
