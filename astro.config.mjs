// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import node from '@astrojs/node';

// DEPLOY_TARGET=node → self-hosted (Coolify/Hetzner) via @astrojs/node standalone.
// Otherwise the Vercel adapter (kept as a fallback target).
const adapter =
  process.env.DEPLOY_TARGET === 'node' ? node({ mode: 'standalone' }) : vercel();

export default defineConfig({
  site: 'https://mattman.ro',
  // Static by default; the on-demand routes (checkout, admin, merch, webhook)
  // opt into SSR via `export const prerender = false`.
  output: 'static',
  adapter,
  // Behind the Coolify/Traefik proxy the Origin/Host pair no longer matches, so
  // Astro's default-on checkOrigin rejects multipart POSTs (the admin photo
  // upload) with "Cross-site POST form submissions are forbidden". Admin routes
  // are cookie-authenticated and same-origin, so the built-in check is disabled.
  security: { checkOrigin: false },
  build: {
    inlineStylesheets: 'auto',
  },
  vite: {},
});
