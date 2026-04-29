// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://matteo-website.vercel.app',
  output: 'static',
  build: {
    inlineStylesheets: 'auto',
  },
  vite: {},
});
