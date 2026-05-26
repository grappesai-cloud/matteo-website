import type { APIRoute } from 'astro';
import { isAuthed } from '../../../lib/admin-auth';
import { uploadImage } from '../../../lib/catalog-store';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB
const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'];

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!isAuthed(cookies)) return json({ error: 'Neautorizat.' }, 401);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Trimite fișierul ca form-data.' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) return json({ error: 'Niciun fișier.' }, 400);
  if (!OK_TYPES.includes(file.type)) return json({ error: 'Folosește PNG, JPG, WEBP sau AVIF.' }, 415);
  if (file.size > MAX_BYTES) return json({ error: 'Fișier prea mare (max 12 MB).' }, 413);

  try {
    const url = await uploadImage(file.name || 'image', file, file.type);
    return json({ ok: true, url });
  } catch (err: any) {
    return json({ error: err?.message || 'Upload eșuat.' }, 500);
  }
};
