import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://kids-library.falkizar.com',
  output: 'server',
  adapter: cloudflare({
    platformProxy: { enabled: true },
    // Astro 6 sessions need a KV binding at runtime; the adapter
    // defaults to one named `SESSION` and Astro fails to render any
    // page if that binding is missing. We don't use Astro.session
    // anywhere in this app (auth is via Cloudflare Access + the JWT
    // middleware), so we just point the binding at the existing
    // ISBN-lookup KV namespace. Session keys are namespaced under
    // `astro:session:` so they don't collide with ISBN cache keys.
    sessionKVBindingName: 'ISBN_CACHE',
  }),
});
