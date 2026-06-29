import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { readCatalog, writeCatalog } from '../../../lib/catalog-store';
import { readArtistMeta, writeArtistMeta } from '../../../lib/artists-store';
import { catalogArtists } from '../../../lib/products';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

const guard = (cookies: any) => (isAdmin(cookies) ? null : json({ error: 'Neautorizat.' }, 401));
const str = (v: unknown, max = 60) => String(v ?? '').trim().slice(0, max);

// LIST artists (ordered + visible) + raw meta
export const GET: APIRoute = async ({ cookies }) => {
  const blocked = guard(cookies);
  if (blocked) return blocked;
  const [all, meta] = await Promise.all([readCatalog(), readArtistMeta()]);
  return json({ artists: catalogArtists(all, meta), meta });
};

// REORDER { order: string[] } — the new display order of the artist tabs.
export const PATCH: APIRoute = async ({ request, cookies }) => {
  const blocked = guard(cookies);
  if (blocked) return blocked;
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }

  const order: string[] = Array.isArray(body?.order)
    ? body.order.map((x: any) => str(x)).filter(Boolean)
    : [];
  if (!order.length) return json({ error: 'Listă de ordine goală.' }, 400);

  const meta = await readArtistMeta();
  // de-dupe, preserving first occurrence
  meta.order = [...new Set(order)];
  try {
    await writeArtistMeta(meta);
  } catch (err: any) {
    return json({ error: err?.message || 'Reordonarea a eșuat.' }, 500);
  }
  const all = await readCatalog();
  return json({ ok: true, artists: catalogArtists(all, meta) });
};

// DELETE { slug } — remove the artist: drops every product of that artist and
// marks the slug hidden so a base artist doesn't reappear as an empty tab.
export const DELETE: APIRoute = async ({ request, cookies }) => {
  const blocked = guard(cookies);
  if (blocked) return blocked;
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }

  const slug = str(body?.slug);
  if (!slug) return json({ error: 'Artist lipsă.' }, 400);

  const all = await readCatalog();
  const next = all.filter((p) => p.artist !== slug);
  const removed = all.length - next.length;

  const meta = await readArtistMeta();
  meta.hidden = [...new Set([...meta.hidden, slug])];
  meta.order = meta.order.filter((s) => s !== slug);

  try {
    if (removed > 0) await writeCatalog(next);
    await writeArtistMeta(meta);
  } catch (err: any) {
    return json({ error: err?.message || 'Ștergerea a eșuat.' }, 500);
  }
  return json({ ok: true, removedProducts: removed, artists: catalogArtists(next, meta) });
};
