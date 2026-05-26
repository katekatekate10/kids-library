/**
 * POST /api/books/[isbn]/reads
 *   body: { kidId, delta? } | { kidId, count? }
 *
 * - `delta`: increment/decrement (legacy "+1 read" button maps here)
 * - `count`: set absolute value (for corrections)
 *
 * Row is upserted on first read for a (kid, book) pair.
 */

import {
  guardPreviewWrites, handler, json, jsonError, readJson,
  type ApiContext,
} from '../../_lib';

interface ReadsBody {
  kidId: string;
  delta?: number;
  count?: number;
}

export const onRequestPost = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const isbn = ctx.params.isbn as string;
  const body = await readJson<ReadsBody>(ctx.request);
  if (!body.kidId) return jsonError('kidId required', 400);

  if (typeof body.count === 'number') {
    const c = Math.max(0, Math.floor(body.count));
    if (c === 0) {
      await ctx.env.DB
        .prepare('DELETE FROM book_reads WHERE kid_id = ? AND book_isbn = ?')
        .bind(body.kidId, isbn).run();
    } else {
      await ctx.env.DB
        .prepare(`
          INSERT INTO book_reads (kid_id, book_isbn, count, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(kid_id, book_isbn) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at
        `)
        .bind(body.kidId, isbn, c).run();
    }
    return json({ kidId: body.kidId, isbn, count: c });
  }

  // delta path — default is +1
  const delta = typeof body.delta === 'number' ? Math.floor(body.delta) : 1;
  await ctx.env.DB
    .prepare(`
      INSERT INTO book_reads (kid_id, book_isbn, count, updated_at)
      VALUES (?, ?, MAX(0, ?), datetime('now'))
      ON CONFLICT(kid_id, book_isbn) DO UPDATE SET
        count = MAX(0, count + excluded.count),
        updated_at = excluded.updated_at
    `)
    .bind(body.kidId, isbn, delta).run();

  // Re-read the row so we return the canonical count (post-MAX).
  const row = await ctx.env.DB
    .prepare('SELECT count FROM book_reads WHERE kid_id = ? AND book_isbn = ?')
    .bind(body.kidId, isbn)
    .first<{ count: number }>();
  return json({ kidId: body.kidId, isbn, count: row?.count ?? 0 });
});
