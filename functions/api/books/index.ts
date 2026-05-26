import {
  bookFromRow, currentEmail, guardPreviewWrites, handler, json,
  jsonError, readJson, type ApiContext, type Book,
} from '../_lib';

interface CreateBookBody {
  isbn: string;
  title?: string | null;
  author?: string | null;
  /** External cover URL (openlibrary, Google Books). For uploaded photos, hit POST /api/books/[isbn]/cover after creation. */
  cover?: string | null;
  source?: 'owned' | 'library';
  location?: 'accessible' | 'backstock';
}

export const onRequestPost = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const body = await readJson<CreateBookBody>(ctx.request);
  if (!body.isbn || typeof body.isbn !== 'string') {
    return jsonError('isbn required', 400);
  }
  const source = body.source ?? 'owned';
  const location = body.location ?? 'backstock';
  const addedDate = new Date().toISOString();
  const placedOnShelfAt = location === 'accessible' ? addedDate : null;

  try {
    await ctx.env.DB
      .prepare(`
        INSERT INTO books
          (isbn, title, author, cover_url, source, location, added_date,
           placed_on_shelf_at, created_by_email, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `)
      .bind(
        body.isbn,
        body.title ?? null,
        body.author ?? null,
        body.cover ?? null,
        source,
        location,
        addedDate,
        placedOnShelfAt,
        currentEmail(ctx.request),
      )
      .run();
  } catch (e: any) {
    if (String(e?.message ?? '').includes('UNIQUE')) {
      return jsonError('book already exists', 409);
    }
    throw e;
  }

  const created: Book = {
    isbn: body.isbn,
    title: body.title ?? null,
    author: body.author ?? null,
    cover: body.cover ?? null,
    source,
    location,
    addedDate,
    placedOnShelfAt,
    lastShelfStint: null,
    readsByKid: {},
  };
  return json(created, { status: 201 });
});
