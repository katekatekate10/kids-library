/**
 * GET /api/lookup/[isbn]
 *
 * Server-side proxy for ISBN → metadata lookup. Hits openlibrary.org
 * first (the legacy app's preferred source), falls back to Google
 * Books. Results are KV-cached for 30 days because book metadata is
 * extremely stable.
 *
 * The legacy app called these APIs directly from the browser, which
 * worked but: (1) exposed every ISBN scan to two third-party services
 * from each device's IP, and (2) hit them uncached. Proxying lets us
 * cache once per ISBN across all family devices and keeps the
 * outbound traffic on a known IP.
 */

import { handler, json, jsonError, type ApiContext } from '../_lib';

const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

interface LookupResult {
  isbn: string;
  title?: string;
  author?: string;
  cover?: string | null;
  source: 'openlibrary' | 'google-books' | 'cache';
}

export const onRequestGet = handler(async (ctx: ApiContext) => {
  const isbn = (ctx.params.isbn as string ?? '').replace(/[^0-9Xx]/g, '');
  if (!isbn) return jsonError('invalid isbn', 400);

  const cacheKey = `isbn:${isbn}`;
  const cached = await ctx.env.ISBN_CACHE.get(cacheKey, 'json');
  if (cached) {
    return json({ ...(cached as LookupResult), source: 'cache' as const });
  }

  const fromOpenLibrary = await tryOpenLibrary(isbn);
  if (fromOpenLibrary) {
    await ctx.env.ISBN_CACHE.put(cacheKey, JSON.stringify(fromOpenLibrary), {
      expirationTtl: TTL_SECONDS,
    });
    return json(fromOpenLibrary);
  }

  const fromGoogle = await tryGoogleBooks(isbn);
  if (fromGoogle) {
    await ctx.env.ISBN_CACHE.put(cacheKey, JSON.stringify(fromGoogle), {
      expirationTtl: TTL_SECONDS,
    });
    return json(fromGoogle);
  }

  return jsonError('isbn not found', 404);
});

async function tryOpenLibrary(isbn: string): Promise<LookupResult | null> {
  const r = await fetch(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`,
  );
  if (!r.ok) return null;
  const j = (await r.json()) as Record<string, any>;
  const d = j[`ISBN:${isbn}`];
  if (!d) return null;
  return {
    isbn,
    title: d.title,
    author: Array.isArray(d.authors) && d.authors[0] ? d.authors[0].name : undefined,
    cover:
      (d.cover && (d.cover.medium || d.cover.large || d.cover.small)) ||
      `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`,
    source: 'openlibrary',
  };
}

async function tryGoogleBooks(isbn: string): Promise<LookupResult | null> {
  const r = await fetch(
    `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`,
  );
  if (!r.ok) return null;
  const j = (await r.json()) as any;
  const v = j.items?.[0]?.volumeInfo;
  if (!v) return null;
  return {
    isbn,
    title: v.title,
    author: Array.isArray(v.authors) ? v.authors.join(', ') : undefined,
    cover: v.imageLinks ? (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail || null) : null,
    source: 'google-books',
  };
}
