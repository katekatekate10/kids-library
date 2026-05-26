/**
 * GET  /api/books/[isbn]/cover  → streams the uploaded cover photo from R2
 * POST /api/books/[isbn]/cover  → body: raw image bytes; uploads to R2 and
 *                                 sets books.cover_r2_key (clears cover_url)
 *
 * Frontend resizes/compresses to ~100KB JPEG client-side before upload.
 * R2 key format: `covers/<isbn>.jpg` (one cover per book; new uploads
 * overwrite).
 */

import {
  guardPreviewWrites, handler, jsonError, type ApiContext,
} from '../../_lib';

const MAX_BYTES = 500_000; // 500KB safety cap; well above the ~100KB we expect

function coverKey(isbn: string): string {
  return `covers/${isbn}.jpg`;
}

export const onRequestGet = handler(async (ctx: ApiContext) => {
  const isbn = ctx.params.isbn as string;
  const obj = await ctx.env.COVERS.get(coverKey(isbn));
  if (!obj) return jsonError('cover not found', 404);
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg',
      // Covers don't change unless replaced; aggressive caching is fine.
      // Cache-buster on update happens via the book's updated_at if needed.
      'cache-control': 'private, max-age=86400',
      'etag': obj.httpEtag,
    },
  });
});

export const onRequestPost = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const isbn = ctx.params.isbn as string;

  const lenHeader = ctx.request.headers.get('content-length');
  if (lenHeader && Number(lenHeader) > MAX_BYTES) {
    return jsonError(`cover too large (>${MAX_BYTES} bytes)`, 413);
  }
  const buf = await ctx.request.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return jsonError(`cover too large (>${MAX_BYTES} bytes)`, 413);
  }
  if (!buf.byteLength) return jsonError('empty body', 400);

  const ct = ctx.request.headers.get('content-type') ?? 'image/jpeg';

  // Confirm the book exists before writing the cover, so we don't
  // leak an R2 object whose owning row never lands.
  const exists = await ctx.env.DB
    .prepare('SELECT 1 AS x FROM books WHERE isbn = ?')
    .bind(isbn)
    .first<{ x: number }>();
  if (!exists) return jsonError('book not found', 404);

  await ctx.env.COVERS.put(coverKey(isbn), buf, {
    httpMetadata: { contentType: ct },
  });
  await ctx.env.DB
    .prepare(`
      UPDATE books SET cover_r2_key = ?, cover_url = NULL, updated_at = datetime('now')
      WHERE isbn = ?
    `)
    .bind(coverKey(isbn), isbn)
    .run();

  return new Response(JSON.stringify({ cover: `/api/books/${isbn}/cover` }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
