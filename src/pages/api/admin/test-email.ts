import type { APIRoute } from 'astro';
import { sessionRole } from '../../../lib/admin-auth';
import { sendTestEmail, notifyConfigured } from '../../../lib/notify';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// Trimite un email de test (șablonul de instrucțiuni retur) către adresele date.
// Doar admin. Util pentru a verifica live că SMTP-ul livrează.
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!sessionRole(cookies)) return json({ error: 'Neautorizat.' }, 401);
  if (!notifyConfigured()) return json({ error: 'SMTP nu e configurat.' }, 503);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const to = String(body?.to ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length) return json({ error: 'Lipsește adresa destinatarului.' }, 400);

  const r = await sendTestEmail(to);
  if (!r.ok) return json({ error: r.error || 'Trimiterea a eșuat.' }, 502);
  return json({ ok: true, sentTo: to });
};
