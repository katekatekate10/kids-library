/**
 * POST /api/books/rotate
 *   body: { decisions: [{ isbn, outcome: 'keep' | 'hit' | 'ignored' }] }
 *
 * Implements the legacy rotation flow: for each decision other than
 * 'keep', move the book to backstock and record a lastShelfStint with
 * placedAt/removedAt/outcome and a snapshot of readsByKid. Mirrors
 * lines 1410-1430 of legacy/index.html.
 *
 * Wrapped in a D1 batch so all moves apply atomically.
 */

import {
  guardPreviewWrites, handler, json, jsonError, readJson,
  type ApiContext, type ShelfStint,
} from '../_lib';

interface RotateBody {
  decisions: Array<{ isbn: string; outcome: 'keep' | 'hit' | 'ignored' }>;
}

interface BookSnap {
  isbn: string;
  placed_on_shelf_at: string | null;
  reads_json: string;
}

export const onRequestPost = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const body = await readJson<RotateBody>(ctx.request);
  if (!Array.isArray(body.decisions)) return jsonError('decisions array required', 400);

  // Only non-'keep' decisions move books off the shelf.
  const moves = body.decisions.filter((d) => d.outcome !== 'keep');
  if (!moves.length) return json({ moved: 0 });

  const isbns = moves.map((d) => d.isbn);
  const placeholders = isbns.map(() => '?').join(',');

  // Pre-fetch the current reads for the affected books in one query.
  // We need them to populate readsAtRemoval in lastShelfStint.
  const readsRows = await ctx.env.DB
    .prepare(`
      SELECT b.isbn,
             b.placed_on_shelf_at,
             COALESCE(
               '{' || GROUP_CONCAT('"' || r.kid_id || '":' || r.count, ',') || '}',
               '{}'
             ) AS reads_json
      FROM books b
      LEFT JOIN book_reads r ON r.book_isbn = b.isbn
      WHERE b.isbn IN (${placeholders})
      GROUP BY b.isbn
    `)
    .bind(...isbns)
    .all<BookSnap>();

  const snapsByIsbn = new Map<string, BookSnap>();
  for (const row of readsRows.results) snapsByIsbn.set(row.isbn, row);

  const now = new Date().toISOString();

  // Batch the updates so they apply atomically.
  const stmts = moves.map((d) => {
    const snap = snapsByIsbn.get(d.isbn);
    if (!snap) return null;
    const stint: ShelfStint = {
      placedAt: snap.placed_on_shelf_at,
      removedAt: now,
      outcome: d.outcome,
      readsAtRemoval: JSON.parse(snap.reads_json || '{}'),
    };
    return ctx.env.DB
      .prepare(`
        UPDATE books
        SET location = 'backstock',
            placed_on_shelf_at = NULL,
            last_shelf_stint = ?,
            updated_at = datetime('now')
        WHERE isbn = ?
      `)
      .bind(JSON.stringify(stint), d.isbn);
  }).filter((s): s is D1PreparedStatement => s != null);

  await ctx.env.DB.batch(stmts);
  return json({ moved: stmts.length });
});
