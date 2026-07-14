import type { APIRoute } from 'astro';
import { readCatalog } from '../lib/catalog-store';
import { activeProducts } from '../lib/products';

export const prerender = false;

const SITE = 'https://mattman.ro';

export const GET: APIRoute = async () => {
  let products: { slug: string }[] = [];
  try {
    products = activeProducts(await readCatalog());
  } catch {
    products = [];
  }

  const urls: { loc: string; priority: string; changefreq: string }[] = [
    { loc: `${SITE}/`, priority: '1.0', changefreq: 'weekly' },
    { loc: `${SITE}/merch`, priority: '0.9', changefreq: 'weekly' },
    ...products.map((p) => ({
      loc: `${SITE}/merch/${p.slug}`,
      priority: '0.8',
      changefreq: 'weekly',
    })),
    { loc: `${SITE}/retur`, priority: '0.4', changefreq: 'yearly' },
    { loc: `${SITE}/termeni`, priority: '0.4', changefreq: 'yearly' },
    { loc: `${SITE}/confidentialitate`, priority: '0.4', changefreq: 'yearly' },
    { loc: `${SITE}/cookies`, priority: '0.3', changefreq: 'yearly' },
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `  <url><loc>${u.loc}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`
  )
  .join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
