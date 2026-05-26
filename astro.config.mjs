// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

export default defineConfig({
  site: 'https://matteo-website.vercel.app',
  // Static by default; the Stripe checkout endpoint opts into on-demand
  // rendering via `export const prerender = false`.
  output: 'static',
  adapter: vercel(),
  build: {
    inlineStylesheets: 'auto',
  },
  vite: {},
});
