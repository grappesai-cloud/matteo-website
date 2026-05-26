import type { APIRoute } from 'astro';
import { checkPassword, isConfigured, setSession } from '../../../lib/admin-auth';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isConfigured()) {
    return json({ error: 'ADMIN_PASSWORD nu este setat în mediu.' }, 503);
  }
  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Cerere invalidă.' }, 400);
  }
  if (!checkPassword(body?.password ?? '')) {
    return json({ error: 'Parolă greșită.' }, 401);
  }
  setSession(cookies);
  return json({ ok: true });
};
