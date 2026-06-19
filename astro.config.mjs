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
  build: {
    inlineStylesheets: 'auto',
  },
  vite: {},
});
