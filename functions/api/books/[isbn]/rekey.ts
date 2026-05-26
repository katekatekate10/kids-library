/**
 * POST /api/books/[isbn]/rekey
 *   body: { newIsbn: string }
 *
 * Renames a book's primary key. Used after OCR refinement identifies
 * the real ISBN for a previously photo-only book whose PK was
 * `manual-<random>`. We update the books row's PK, then update the
 * FK columns on book_reads and reviews to point at the new ISBN,
 * then move the R2 cover object to the new key. All wrapped in a
 * D1 batch so the table updates apply atomically; the R2 move
 * happens after the DB transaction commits because R2 isn't part
 * of the batch.
 *
 * Why not ON UPDATE CASCADE: the 0001 schema declared FKs with
 * ON DELETE CASCADE only. Adding ON UPDATE CASCADE in SQLite
 * requires recreating the tables (DROP + CREATE + INSERT-SELECT)
 * which is too invasive for one feature. Manual cascade in a batch
 * is functionally equivalent.
 *
 * Failure modes handled:
 *   - new ISBN already exists on another book → 409
 *   - new ISBN equals old → 400
 *   - book not found → 404
 *   - R2 move partial failure → DB stays consistent; cover may
 *     temporarily be unreferenced or referenced at the old key.
 *     The cover_r2_key column carries the truth.
 */

import {
  guardPreviewWrites, handler, json, jsonError, readJson,
  type ApiContext,
} from '../../_lib';

interface RekeyBody {
  newIsbn: string;
}

export const onRequestPost = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const oldIsbn = ctx.params.isbn as string;
  const body = await readJson<RekeyBody>(ctx.request);
  const newIsbn = String(body.newIsbn ?? '').trim();

  if (!newIsbn) return jsonError('newIsbn required', 400);
  if (newIsbn === oldIsbn) return jsonError('newIsbn is the same as the current isbn', 400);
  // Light validation — ISBN-13 form. Allows other PK shapes too, since
  // some imports may include ISBN-10. Don't reject things that look weird;
  // just reject the obvious garbage.
  if (newIsbn.length < 8 || newIsbn.length > 32) {
    return jsonError('newIsbn looks malformed', 400);
  }

  const db = ctx.env.DB;

  // Verify old book exists.
  const old = await db
    .prepare('SELECT cover_r2_key FROM books WHERE isbn = ?')
    .bind(oldIsbn)
    .first<{ cover_r2_key: string | null }>();
  if (!old) return jsonError('book not found', 404);

  // Verify new ISBN isn't already taken.
  const conflict = await db
    .prepare('SELECT 1 AS x FROM books WHERE isbn = ?')
    .bind(newIsbn)
    .first<{ x: number }>();
  if (conflict) {
    return jsonError(
      'a book with that ISBN already exists in the library — merge manually',
      409,
    );
  }

  // Compute new R2 key (if there's a cover to move).
  const oldKey = old.cover_r2_key;
  const newKey = oldKey ? `covers/${newIsbn}.jpg` : null;

  // Atomic DB transaction: update books.isbn, then update FKs.
  // book_reads and reviews are deferred via ON DELETE CASCADE only;
  // we explicitly UPDATE them here because the column they reference
  // is the PK and we need them to point at the new value.
  //
  // Order matters: insert new book row, copy FKs to new isbn, drop
  // old book row. ON DELETE CASCADE on book_reads/reviews would
  // otherwise wipe them when we deleted the old row.
  //
  // The simpler "UPDATE books SET isbn = ?" doesn't work because
  // there's no ON UPDATE CASCADE on the FK columns; the children
  // would dangle.
  await db.batch([
    // Copy the row, swapping isbn (and cover_r2_key if relevant).
    db.prepare(`
      INSERT INTO books (
        isbn, title, author, authors_json, subjects_json, publish_year,
        cover_url, cover_r2_key, source, location, added_date,
        placed_on_shelf_at, last_shelf_stint, created_by_email, updated_at
      )
      SELECT
        ? AS isbn, title, author, authors_json, subjects_json, publish_year,
        cover_url, ? AS cover_r2_key, source, location, added_date,
        placed_on_shelf_at, last_shelf_stint, created_by_email, datetime('now')
      FROM books WHERE isbn = ?
    `).bind(newIsbn, newKey, oldIsbn),

    // Repoint child rows.
    db.prepare('UPDATE book_reads SET book_isbn = ? WHERE book_isbn = ?').bind(newIsbn, oldIsbn),
    db.prepare('UPDATE reviews    SET book_isbn = ? WHERE book_isbn = ?').bind(newIsbn, oldIsbn),

    // Remove the old book row last. ON DELETE CASCADE will fire on any
    // child rows still pointing at oldIsbn — none should, because we
    // just moved them. So this is a safety no-op on cascades.
    db.prepare('DELETE FROM books WHERE isbn = ?').bind(oldIsbn),
  ]);

  // Move the R2 cover if there was one. Best-effort: if this fails
  // after the DB commit, cover_r2_key in DB points at a key that
  // doesn't yet exist in R2; the cover GET would 404. Acceptable —
  // user can re-upload via the cover endpoint.
  if (oldKey && newKey) {
    try {
      const obj = await ctx.env.COVERS.get(oldKey);
      if (obj) {
        await ctx.env.COVERS.put(newKey, obj.body, {
          httpMetadata: obj.httpMetadata,
        });
        await ctx.env.COVERS.delete(oldKey);
      }
    } catch (e) {
      console.error('R2 cover move failed for', oldIsbn, '→', newIsbn, e);
      // Don't fail the whole rekey — the user got their new ISBN.
    }
  }

  return json({ oldIsbn, newIsbn, coverMoved: Boolean(oldKey) });
});
