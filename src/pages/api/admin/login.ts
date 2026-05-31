import type { APIRoute } from 'astro';
import { checkPassword, isConfigured, setSession } from '../../../lib/admin-auth';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isConfigured('admin') && !isConfigured('ruvix')) {
    return json({ error: 'Nicio parolă nu este setată în mediu (ADMIN_PASSWORD / RUVIX_PASSWORD).' }, 503);
  }
  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Cerere invalidă.' }, 400);
  }
  const role = checkPassword(body?.password ?? '');
  if (!role) {
    return json({ error: 'Parolă greșită.' }, 401);
  }
  setSession(cookies, role);
  return json({ ok: true, role });
};
