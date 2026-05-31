// === ORDER NOTIFICATIONS — email to Ruvix (Resend, env-gated) ===
// When RESEND_API_KEY + RUVIX_EMAIL are set, a new paid order triggers an email
// to the Ruvix fulfillment team (in addition to the dashboard). Without them,
// notifyRuvixNewOrder() is a safe no-op. NOTIFY_FROM sets the sender (must be a
// Resend-verified domain); defaults to Resend's test sender.

import { formatAddress, orderUnits, type Order } from './orders';

function env(k: string): string {
  return (process.env[k] || (import.meta.env as any)[k] || '').trim();
}

export function notifyConfigured(): boolean {
  return !!(env('RESEND_API_KEY') && env('RUVIX_EMAIL'));
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

/** Best-effort: email Ruvix about a new order. Never throws. */
export async function notifyRuvixNewOrder(order: Order, origin: string): Promise<void> {
  if (!notifyConfigured()) return;
  const from = env('NOTIFY_FROM') || 'Mattman Music <onboarding@resend.dev>';
  const to = env('RUVIX_EMAIL').split(',').map((s) => s.trim()).filter(Boolean);
  const adminUrl = `${origin.replace(/\/$/, '')}/admin`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('RESEND_API_KEY')}` },
      body: JSON.stringify({
        from,
        to,
        subject: `Comandă nouă #${order.number} — ${order.amountTotal} ${order.currency}`,
        html: buildHtml(order, adminUrl),
      }),
    });
    if (!res.ok) {
      console.error('[notify] Resend error:', res.status, await res.text().catch(() => ''));
    }
  } catch (err: any) {
    console.error('[notify] email failed:', err?.message);
  }
}
