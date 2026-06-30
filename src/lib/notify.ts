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

// === Email design tokens — mirror the website (src/styles/global.css) ===
const SERIF = "Georgia, 'Times New Roman', Times, serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const INK = '#0A0A0A';
const INK_SOFT = '#141414';
const CREAM = '#F2EBE0';
const CREAM_DIM = '#A89F90';
const GOLD = '#C9A24A';
const GOLD_BRIGHT = '#E8C16C';
const HAIR = 'rgba(242,235,224,0.14)';

/** A label/value row inside the dark info panels. */
function emailRow(label: string, value: string): string {
  return `
    <tr>
      <td style="padding:3px 0;font:600 11px/1.5 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${GOLD};white-space:nowrap;vertical-align:top">${label}</td>
      <td style="padding:3px 0 3px 16px;font:400 14px/1.55 ${SANS};color:${CREAM};vertical-align:top">${value}</td>
    </tr>`;
}

function buildCustomerShippedHtml(order: Order): string {
  const name = esc(order.customer?.name || order.shipping?.name || 'dragă fan');
  const url = trackUrl(order);
  const courier = esc(order.courier || 'curier');
  const awb = esc(order.awb || '—');

  const items = order.items
    .map((i) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid ${HAIR};font:400 15px/1.4 ${SERIF};color:${CREAM}">
          ${esc(i.name)}
          <span style="display:block;margin-top:3px;font:400 12px/1.4 ${SANS};letter-spacing:.04em;color:${CREAM_DIM}">${esc(String(i.size))}${i.colorLabel ? ' · ' + esc(i.colorLabel) : ''}</span>
        </td>
        <td style="padding:10px 0;border-bottom:1px solid ${HAIR};font:600 14px/1.4 ${SANS};color:${GOLD};text-align:right;white-space:nowrap;vertical-align:top">×${esc(i.qty)}</td>
      </tr>`)
    .join('');

  const cta = url
    ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px">
        <tr><td style="border-radius:4px;background:${GOLD}">
          <a href="${esc(url)}" style="display:inline-block;padding:15px 34px;font:700 13px/1 ${SANS};letter-spacing:.1em;text-transform:uppercase;color:${INK};text-decoration:none">Urmărește coletul →</a>
        </td></tr>
      </table>
      <p style="margin:0;font:400 13px/1.6 ${SANS};color:${CREAM_DIM}">AWB <span style="color:${CREAM};font-weight:600">${awb}</span> · ${courier}</p>`
    : `<p style="margin:0;font:400 14px/1.6 ${SANS};color:${CREAM}">AWB <span style="font-weight:600">${awb}</span>${order.courier ? ' · ' + courier : ''}</p>`;

  return `
<!DOCTYPE html>
<html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"></head>
<body style="margin:0;padding:0;background:${INK};-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">Comanda #${order.number} e pe drum. AWB ${awb}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${INK}">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${INK_SOFT};border:1px solid ${HAIR};border-radius:8px;overflow:hidden">

        <!-- wordmark -->
        <tr><td style="padding:30px 36px 0;text-align:center">
          <span style="font:700 13px/1 ${SANS};letter-spacing:.42em;text-transform:uppercase;color:${GOLD}">MATTMAN&nbsp;MUSIC</span>
        </td></tr>

        <!-- hero -->
        <tr><td style="padding:26px 36px 8px;text-align:center">
          <span style="display:inline-block;margin:0 0 14px;padding:6px 14px;border:1px solid ${HAIR};border-radius:999px;font:600 11px/1 ${SANS};letter-spacing:.16em;text-transform:uppercase;color:${CREAM_DIM}">Comanda #${order.number}</span>
          <h1 style="margin:0;font:400 34px/1.1 ${SERIF};color:${CREAM}">Coletul tău<br><em style="color:${GOLD_BRIGHT};font-style:italic">e pe drum.</em></h1>
          <p style="margin:14px 0 0;font:400 15px/1.6 ${SANS};color:${CREAM_DIM}">Mulțumim, ${name}. L-am predat curierului și pornește spre tine.</p>
        </td></tr>

        <!-- tracking -->
        <tr><td style="padding:24px 36px 4px;text-align:center">${cta}</td></tr>

        <!-- divider -->
        <tr><td style="padding:24px 36px 0"><div style="height:1px;background:${HAIR};line-height:1px;font-size:0">&nbsp;</div></td></tr>

        <!-- produse -->
        <tr><td style="padding:22px 36px 0">
          <p style="margin:0 0 4px;font:600 11px/1 ${SANS};letter-spacing:.16em;text-transform:uppercase;color:${GOLD}">Produse</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}
            <tr><td style="padding:14px 0 0;font:600 12px/1.4 ${SANS};letter-spacing:.04em;color:${CREAM_DIM}">Total</td>
                <td style="padding:14px 0 0;font:700 15px/1.4 ${SANS};color:${CREAM};text-align:right">${esc(order.amountTotal)} ${esc(order.currency)}</td></tr>
          </table>
        </td></tr>

        <!-- livrare -->
        <tr><td style="padding:22px 36px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${INK};border:1px solid ${HAIR};border-radius:6px">
            <tr><td style="padding:16px 18px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${emailRow('Livrare', esc(formatAddress(order.shipping || {}) || 'fără adresă'))}
              </table>
            </td></tr>
          </table>
        </td></tr>

        <!-- note -->
        <tr><td style="padding:18px 36px 0">
          <p style="margin:0;font:400 12px/1.6 ${SANS};color:${CREAM_DIM}">Imediat după preluare, curierul poate afișa „AWB înregistrat de expeditor". E normal: statusul se actualizează după ce coletul e scanat fizic.</p>
        </td></tr>

        <!-- footer -->
        <tr><td style="padding:28px 36px 30px;text-align:center;border-top:1px solid ${HAIR};margin-top:8px">
          <p style="margin:24px 0 4px;font:700 12px/1 ${SANS};letter-spacing:.3em;text-transform:uppercase;color:${GOLD}">MATTMAN MUSIC</p>
          <p style="margin:0;font:400 12px/1.5 ${SANS};color:${CREAM_DIM}"><a href="https://mattman.ro" style="color:${CREAM_DIM};text-decoration:none">mattman.ro</a></p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
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
