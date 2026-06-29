import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { readLanding, writeLanding } from '../../../lib/landing-store';
import { seedLanding, SOCIAL_KINDS, type Artist, type LandingContent } from '../../../lib/landing';
import { slugify } from '../../../lib/products';

/** Max artists shown in the roster grid. */
const ROSTER_MAX = 8;

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

const guard = (cookies: any) => (isAdmin(cookies) ? null : json({ error: 'Neautorizat.' }, 401));

const str = (v: unknown, max = 600) => String(v ?? '').trim().slice(0, max);
const strs = (v: unknown, max: number, cap: number) =>
  (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, cap);

/** Sanitize one artist. Returns null when it has no usable name (drop it). */
function sanitizeArtist(input: any): Artist | null {
  const name = str(input?.name, 80);
  if (!name) return null;
  const tracks = (Array.isArray(input?.tracks) ? input.tracks : [])
    .map((t: any) => ({ id: str(t?.id, 40), title: str(t?.title, 120), year: str(t?.year, 8) || undefined }))
    .filter((t: any) => t.id && t.title)
    .slice(0, 12);
  const downloads = (Array.isArray(input?.downloads) ? input.downloads : [])
    .map((d: any) => ({ label: str(d?.label, 80), href: str(d?.href, 600), external: !!d?.external, size: str(d?.size, 20) || undefined }))
    .filter((d: any) => d.label && d.href)
    .slice(0, 16);
  const socials = (Array.isArray(input?.socials) ? input.socials : [])
    .map((s: any) => ({ kind: str(s?.kind, 20).toLowerCase(), href: str(s?.href, 600) }))
    .filter((s: any) => SOCIAL_KINDS.includes(s.kind) && s.href)
    .slice(0, 8);
  return {
    slug: slugify(str(input?.slug, 40) || name) || 'artist',
    name,
    tagline: str(input?.tagline, 140),
    photo: str(input?.photo, 600),
    bio: strs(input?.bio, 800, 8),
    tracks,
    downloads,
    socials,
  };
}

function sanitize(input: any): LandingContent {
  // Roster is now fully editable: add / delete / reorder, in the given order.
  const used = new Set<string>();
  const roster: Artist[] = [];
  for (const a of Array.isArray(input?.roster) ? input.roster : []) {
    const art = sanitizeArtist(a);
    if (!art) continue;
    let slug = art.slug;
    for (let n = 2; used.has(slug); n++) slug = `${art.slug}-${n}`;
    used.add(slug);
    roster.push({ ...art, slug });
    if (roster.length >= ROSTER_MAX) break;
  }
  // never persist an empty roster — fall back to the seed
  const finalRoster = roster.length ? roster : seedLanding.roster;

  const tilesIn = new Map<string, any>(
    (Array.isArray(input?.tiles) ? input.tiles : []).map((t: any) => [str(t?.slug, 40), t])
  );
  const tiles = seedLanding.tiles.map((seed) => {
    const t = tilesIn.get(seed.slug) ?? {};
    return {
      slug: seed.slug,
      label: str(t?.label, 40) || seed.label,
      sub: str(t?.sub, 80),
      href: str(t?.href, 600) || seed.href,
      disabled: !!t?.disabled,
    };
  });

  return {
    headerSub: str(input?.headerSub, 120),
    footerEmail: str(input?.footerEmail, 120) || seedLanding.footerEmail,
    roster: finalRoster,
    tiles,
  };
}

export const GET: APIRoute = async ({ cookies }) => {
  const blocked = guard(cookies);
  if (blocked) return blocked;
  return json({ content: await readLanding() });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const blocked = guard(cookies);
  if (blocked) return blocked;
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Cerere invalidă.' }, 400); }
  const content = sanitize(body);
  try {
    await writeLanding(content);
  } catch (err: any) {
    return json({ error: err?.message || 'Salvarea a eșuat.' }, 500);
  }
  return json({ ok: true, content });
};
