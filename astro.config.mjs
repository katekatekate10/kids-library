import { defineConfig } from 'astro/config';

// Static Astro build. Per-request server logic lives in Pages
// Functions (functions/), not Astro SSR. We tried Astro SSR with
// @astrojs/cloudflare 13 first, but that adapter targets Cloudflare
// Workers (Workers Assets pattern) and isn't auto-detected by
// Cloudflare Pages — Pages serves dist/ as static and 404s everything.
// Matches the web-hub's setup.
export default defineConfig({
  site: 'https://kids-library.falkizar.com',
});
