import {
  bookFromRow, guardPreviewWrites, handler, json, jsonError, readJson,
  readsByBook, type ApiContext, type Book,
} from '../_lib';

interface UpdateBookBody {
  title?: string | null;
  authors?: string[];
  subjects?: string[];
  publishYear?: string | null;
  cover?: string | null;                 // external URL only; uploads go to cover.ts
  source?: 'owned' | 'library';
  location?: 'accessible' | 'backstock';
  /** When moving between accessible<->backstock, server stamps placedOnShelfAt automatically. */
}

async function loadBook(db: D1Database, isbn: string): Promise<Book | null> {
  const row = await db
    .prepare(`
      SELECT isbn, title, author, authors_json, subjects_json, publish_year,
             cover_url, cover_r2_key, source, location,
             added_date, placed_on_shelf_at, last_shelf_stint
      FROM books WHERE isbn = ?
    `)
    .bind(isbn)
    .first();
  if (!row) return null;
  const reads = await readsByBook(db);
  return bookFromRow(row as any, reads.get(isbn) ?? {});
}

export const onRequestPatch = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const isbn = ctx.params.isbn as string;
  const body = await readJson<UpdateBookBody>(ctx.request);

  const sets: string[] = [];
  const args: unknown[] = [];

  if ('title' in body)       { sets.push('title = ?');         args.push(body.title); }
  if ('authors' in body)     { sets.push('authors_json = ?');  args.push(body.authors?.length ? JSON.stringify(body.authors) : null); }
  if ('subjects' in body)    { sets.push('subjects_json = ?'); args.push(body.subjects?.length ? JSON.stringify(body.subjects) : null); }
  if ('publishYear' in body) { sets.push('publish_year = ?');  args.push(body.publishYear); }
  if ('cover' in body)       { sets.push('cover_url = ?');     args.push(body.cover); sets.push('cover_r2_key = NULL'); }
  if ('source' in body)      { sets.push('source = ?');        args.push(body.source); }
  if ('location' in body) {
    sets.push('location = ?'); args.push(body.location);
    // Moving onto the accessible shelf stamps placed_on_shelf_at; moving off clears it.
    if (body.location === 'accessible') {
      sets.push("placed_on_shelf_at = COALESCE(placed_on_shelf_at, datetime('now'))");
    } else {
      sets.push('placed_on_shelf_at = NULL');
    }
  }

  if (!sets.length) return jsonError('no fields to update', 400);
  sets.push("updated_at = datetime('now')");
  args.push(isbn);

  const result = await ctx.env.DB
    .prepare(`UPDATE books SET ${sets.join(', ')} WHERE isbn = ?`)
    .bind(...args)
    .run();
  if (!result.meta.changes) return jsonError('book not found', 404);

  return json(await loadBook(ctx.env.DB, isbn));
});

/** Delete the book + its cover photo from R2 if any. Cascades to book_reads + reviews. */
export const onRequestDelete = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const isbn = ctx.params.isbn as string;

  const row = await ctx.env.DB
    .prepare('SELECT cover_r2_key FROM books WHERE isbn = ?')
    .bind(isbn)
    .first<{ cover_r2_key: string | null }>();
  if (!row) return jsonError('book not found', 404);

  if (row.cover_r2_key) {
    await ctx.env.COVERS.delete(row.cover_r2_key);
  }
  await ctx.env.DB.prepare('DELETE FROM books WHERE isbn = ?').bind(isbn).run();
  return json({ deleted: isbn });
});
