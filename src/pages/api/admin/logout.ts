import type { APIRoute } from 'astro';
import { clearSession } from '../../../lib/admin-auth';

export const prerender = false;

export const POST: APIRoute = async ({ cookies }) => {
  clearSession(cookies);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
