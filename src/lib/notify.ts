// === ORDER NOTIFICATIONS — email „comandă nouă" prin SMTP (env-gated) ===
// Când SMTP_HOST + SMTP_USER + SMTP_PASS sunt setate, o comandă nouă plătită
// trimite un email (de la căsuța shop@mattman.ro de pe cyberfolks) către
// ORDER_NOTIFY_EMAIL (default = SMTP_USER). Fără ele, notifyRuvixNewOrder() e un
// no-op sigur. Trimitere best-effort: nu aruncă niciodată.

import nodemailer from 'nodemailer';
import { formatAddress, orderUnits, type Order } from './orders';
import { fanTrackingUrl } from './fancourier';
import { updateOrder } from './orders-store';

function env(k: string): string {
  return (process.env[k] || (import.meta.env as any)[k] || '').trim();
}

function smtpConfigured(): boolean {
  return !!(env('SMTP_HOST') && env('SMTP_USER') && env('SMTP_PASS'));
}

function resendConfigured(): boolean {
  return !!env('RESEND_API_KEY');
}

export function notifyConfigured(): boolean {
  // Resend (HTTP) is preferred because Netcup blocks outbound SMTP ports.
  return resendConfigured() || smtpConfigured();
}

/** The From header — env override, else the SMTP user, else Resend's sandbox sender. */
function fromHeader(): string {
  const name = env('NOTIFY_FROM_NAME') || 'Mattman Music';
  const addr = env('NOTIFY_FROM') || env('SMTP_USER') || 'onboarding@resend.dev';
  // NOTIFY_FROM may already include a display name (e.g. "X <a@b>") — use as-is then.
  return addr.includes('<') ? addr : `${name} <${addr}>`;
}

/**
 * Deliver one email. Prefers Resend HTTP API (port 443, works on Netcup);
 * falls back to SMTP. Throws on failure so callers can surface the reason.
 */
async function deliver(msg: { from: string; to: string | string[]; subject: string; html: string }): Promise<void> {
  if (resendConfigured()) {
    const to = Array.isArray(msg.to) ? msg.to : [msg.to];
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: msg.from, to, subject: msg.subject, html: msg.html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
    }
    return;
  }
  await getTransport().sendMail(msg);
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}

function buildHtml(order: Order, adminUrl: string): string {
  const items = order.items
    .map((i) => `<li><strong>${i.qty}×</strong> ${esc(i.name)} — ${esc(String(i.size))}${i.colorLabel ? ' · ' + esc(i.colorLabel) : ''}</li>`)
    .join('');
  const c = order.customer || {};
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111">
    <h2 style="margin:0 0 4px">Comandă nouă #${order.number}</h2>
    <p style="margin:0 0 16px;color:#666">${orderUnits(order)} produs(e) · ${order.amountTotal} ${esc(order.currency)}</p>
    <h3 style="margin:0 0 6px">Produse</h3>
    <ul style="margin:0 0 16px;padding-left:18px;line-height:1.6">${items}</ul>
    <h3 style="margin:0 0 6px">Livrare</h3>
    <p style="margin:0 0 4px"><strong>${esc(c.name || order.shipping?.name || '—')}</strong></p>
    <p style="margin:0 0 4px">${esc([c.phone, c.email].filter(Boolean).join(' · ') || '—')}</p>
    <p style="margin:0 0 16px">📦 ${esc(formatAddress(order.shipping || {}) || 'fără adresă')}</p>
    <p style="margin:0"><a href="${esc(adminUrl)}" style="background:#c9a24a;color:#0a0a0a;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Deschide dashboard-ul</a></p>
  </div>`;
}

/** Public tracking URL for an order's AWB — FAN gets its tracker, others a generic note. */
function trackUrl(order: Order): string | null {
  if (!order.awb) return null;
  const courier = (order.courier || '').toLowerCase();
  if (!courier || courier.includes('fan')) return fanTrackingUrl(order.awb);
  return null; // unknown courier — show the AWB without a link
}

function buildCustomerShippedHtml(order: Order): string {
  const items = order.items
    .map((i) => `<li><strong>${i.qty}×</strong> ${esc(i.name)} · ${esc(String(i.size))}${i.colorLabel ? ' · ' + esc(i.colorLabel) : ''}</li>`)
    .join('');
  const url = trackUrl(order);
  const cta = url
    ? `<p style="margin:0 0 8px"><a href="${esc(url)}" style="background:#c9a24a;color:#0a0a0a;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold">Urmărește comanda</a></p>
       <p style="margin:0 0 16px;color:#666;font-size:13px">sau caută AWB-ul <strong>${esc(order.awb)}</strong> pe <a href="${esc(url)}" style="color:#0a0a0a">${esc(order.courier || 'curier')}</a></p>`
    : `<p style="margin:0 0 16px">AWB: <strong>${esc(order.awb || '—')}</strong>${order.courier ? ' · ' + esc(order.courier) : ''}</p>`;
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111">
    <h2 style="margin:0 0 4px">Comanda ta #${order.number} a fost expediată 🎉</h2>
    <p style="margin:0 0 16px;color:#666">Mulțumim, ${esc(order.customer?.name || order.shipping?.name || 'dragă fan')}! Coletul tău e pe drum.</p>
    <h3 style="margin:0 0 6px">Urmărire</h3>
    ${cta}
    <p style="margin:0 0 16px;color:#888;font-size:12px">Notă: imediat după generarea AWB-ului, curierul poate afișa „AWB înregistrat de expeditor". E normal — statusul se actualizează după ce coletul e preluat fizic.</p>
    <h3 style="margin:0 0 6px">Produse</h3>
    <ul style="margin:0 0 16px;padding-left:18px;line-height:1.6">${items}</ul>
    <h3 style="margin:0 0 6px">Livrare</h3>
    <p style="margin:0">📦 ${esc(formatAddress(order.shipping || {}) || 'fără adresă')}</p>
    <p style="margin:24px 0 0;color:#999;font-size:12px">Mattman Music</p>
  </div>`;
}

/**
 * Best-effort: email the CUSTOMER that their order shipped, with a tracking link.
 * Returns true only if the message was actually sent (so the caller can stamp
 * shippedEmailAt and avoid re-sending). Never throws.
 */
/** Send the shipped email; returns the SMTP error message instead of swallowing it. */
export async function sendCustomerShipped(order: Order, toOverride?: string): Promise<{ ok: boolean; error?: string }> {
  if (!notifyConfigured()) return { ok: false, error: 'SMTP not configured' };
  const to = (toOverride || order.customer?.email || '').trim();
  if (!to) return { ok: false, error: 'no recipient' };
  try {
    await deliver({
      from: fromHeader(),
      to,
      subject: `Comanda #${order.number} a fost expediată 🎉`,
      html: buildCustomerShippedHtml(order),
    });
    return { ok: true };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[notify] customer shipped email failed:', msg);
    return { ok: false, error: msg };
  }
}

export async function notifyCustomerShipped(order: Order, toOverride?: string): Promise<boolean> {
  return (await sendCustomerShipped(order, toOverride)).ok;
}

/**
 * Idempotently email the customer when an order is shipped with an AWB.
 * Sends at most once (guarded by shippedEmailAt) and stamps the order on success.
 * Returns the (possibly stamped) order. Safe to call after every fulfillment save.
 */
export async function maybeNotifyShipped(order: Order): Promise<Order> {
  if (order.status !== 'shipped' || !order.awb || order.shippedEmailAt) return order;
  const sent = await notifyCustomerShipped(order);
  if (!sent) return order;
  const stamped = await updateOrder(order.id, { shippedEmailAt: Date.now() });
  return stamped || { ...order, shippedEmailAt: Date.now() };
}

let transporter: nodemailer.Transporter | null = null;
function getTransport(): nodemailer.Transporter {
  if (transporter) return transporter;
  const port = Number(env('SMTP_PORT')) || 465;
  transporter = nodemailer.createTransport({
    host: env('SMTP_HOST'),
    port,
    secure: port === 465, // 465 = SSL, 587 = STARTTLS
    auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
    // Fail fast instead of hanging ~2 min when the SMTP host/port is unreachable.
    connectionTimeout: 12000,
    greetingTimeout: 8000,
    socketTimeout: 20000,
  });
  return transporter;
}

/** Best-effort: email owner about a new order via SMTP. Never throws. */
export async function notifyRuvixNewOrder(order: Order, origin: string): Promise<void> {
  if (!notifyConfigured()) return;
  const to = (env('ORDER_NOTIFY_EMAIL') || env('NOTIFY_FROM') || env('SMTP_USER'))
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length) return;
  const adminUrl = `${origin.replace(/\/$/, '')}/admin`;
  try {
    await deliver({
      from: fromHeader(),
      to,
      subject: `Comandă nouă #${order.number} ${order.amountTotal} ${order.currency}`,
      html: buildHtml(order, adminUrl),
    });
  } catch (err: any) {
    console.error('[notify] new-order email failed:', err?.message);
  }
}
