// === ORDER NOTIFICATIONS — email „comandă nouă" prin SMTP (env-gated) ===
// Când SMTP_HOST + SMTP_USER + SMTP_PASS sunt setate, o comandă nouă plătită
// trimite un email (de la căsuța shop@mattman.ro de pe cyberfolks) către
// ORDER_NOTIFY_EMAIL (default = SMTP_USER). Fără ele, notifyRuvixNewOrder() e un
// no-op sigur. Trimitere best-effort: nu aruncă niciodată.

import nodemailer from 'nodemailer';
import { formatAddress, orderUnits, type Order } from './orders';

function env(k: string): string {
  return (process.env[k] || (import.meta.env as any)[k] || '').trim();
}

export function notifyConfigured(): boolean {
  return !!(env('SMTP_HOST') && env('SMTP_USER') && env('SMTP_PASS'));
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

let transporter: nodemailer.Transporter | null = null;
function getTransport(): nodemailer.Transporter {
  if (transporter) return transporter;
  const port = Number(env('SMTP_PORT')) || 465;
  transporter = nodemailer.createTransport({
    host: env('SMTP_HOST'),
    port,
    secure: port === 465, // 465 = SSL, 587 = STARTTLS
    auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
  });
  return transporter;
}

/** Best-effort: email owner about a new order via SMTP. Never throws. */
export async function notifyRuvixNewOrder(order: Order, origin: string): Promise<void> {
  if (!notifyConfigured()) return;
  const fromName = env('NOTIFY_FROM_NAME') || 'Mattman Music';
  const from = `${fromName} <${env('SMTP_USER')}>`;
  const to = (env('ORDER_NOTIFY_EMAIL') || env('SMTP_USER'))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const adminUrl = `${origin.replace(/\/$/, '')}/admin`;
  try {
    await getTransport().sendMail({
      from,
      to,
      subject: `Comandă nouă #${order.number} — ${order.amountTotal} ${order.currency}`,
      html: buildHtml(order, adminUrl),
    });
  } catch (err: any) {
    console.error('[notify] SMTP email failed:', err?.message);
  }
}
