/**
 * Service worker — Kids' Library
 *
 * Goal: installable PWA + sane offline behavior. Specifically:
 *   - Shell (HTML + bundled JS/CSS) loads even on slow / no network
 *     once you've used the app once.
 *   - Cover images (served from /api/books/.../cover, backed by R2)
 *     show instantly on subsequent loads, refresh in background.
 *   - Data endpoints (/api/state, /api/books POST/PATCH, etc.) are
 *     ALWAYS network — we never want to render stale state.
 *   - Bumping CACHE_VERSION below cleans up old caches on next visit.
 *
 * What this file deliberately does NOT do:
 *   - Background sync — needs a queue model the app doesn't have yet.
 *   - Push notifications — needs backend, not asked for.
 *   - Custom offline page — we just fail gracefully if the shell
 *     isn't cached and the network is down. The app shell is small
 *     enough that one online visit primes the cache.
 *
 * Versioning convention: bump CACHE_VERSION whenever the strategies
 * change. Astro adds content hashes to /_astro/* paths, so we don't
 * need to bump the version for normal code/style changes — the
 * runtime cache key is the URL.
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const ASSETS_CACHE = `assets-${CACHE_VERSION}`;
const COVERS_CACHE = `covers-${CACHE_VERSION}`;

const SHELL_URLS = [
  '/',
  '/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Delete any cache whose name doesn't end with our current version.
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => !k.endsWith(CACHE_VERSION))
        .map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GETs. Anything that mutates state goes straight to network.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only — we don't want to cache third-party calls.
  if (url.origin !== self.location.origin) return;

  // ---- DATA endpoints: always network, never cache ----
  // /api/state is the authoritative snapshot; /api/lookup/* is
  // already KV-cached server-side; /api/me changes per session.
  if (
    url.pathname === '/api/state' ||
    url.pathname === '/api/me' ||
    url.pathname.startsWith('/api/lookup/') ||
    url.pathname.startsWith('/api/admin/') ||
    url.pathname.startsWith('/api/kids') ||
    url.pathname.startsWith('/api/reviews')
  ) {
    return; // default network fetch
  }

  // ---- COVERS: stale-while-revalidate ----
  // Pattern: serve cached immediately if present, refresh in background.
  // Covers are immutable per-isbn (uploads overwrite the same R2 key,
  // but R2's etag changes — the revalidation picks that up).
  if (url.pathname.startsWith('/api/books/') && url.pathname.endsWith('/cover')) {
    event.respondWith(staleWhileRevalidate(COVERS_CACHE, req));
    return;
  }

  // ---- BUNDLED ASSETS (/_astro/*): cache-first ----
  // Astro hashes file names by content, so the cached version is
  // always correct for the URL. Save a roundtrip.
  if (url.pathname.startsWith('/_astro/')) {
    event.respondWith(cacheFirst(ASSETS_CACHE, req));
    return;
  }

  // ---- HTML NAVIGATIONS: network-first, cache-fallback ----
  // Why network-first here: if the user's Cloudflare Access cookie
  // expires, the network path returns a 302 to SSO that the browser
  // CAN follow for a top-level navigation (it can't follow it for
  // XHR fetches from script). Serving cached HTML in that scenario
  // would boot the app into a permanently-broken state where every
  // /api/* fetch fails and the user has no way to re-auth without
  // a hard reload. So: prefer network for navigations; only fall
  // back to cache when offline.
  if (req.mode === 'navigate' || SHELL_URLS.includes(url.pathname)) {
    event.respondWith(networkFirst(SHELL_CACHE, req));
    return;
  }
});

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached); // network failed → fall back to cached
  return cached || fetchPromise;
}

async function networkFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    // Only cache successful, non-opaque-redirect responses.
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error('offline and no cached copy');
  }
}
