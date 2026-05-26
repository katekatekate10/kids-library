/**
 * GET /api/state — full snapshot of the app's data for boot.
 *
 * The legacy app held kids+books+reviews in localStorage as one blob
 * and re-rendered everything from memory. Mirroring that shape here
 * keeps the frontend port mechanical: replace loadState() with
 * `await fetch('/api/state').then(r => r.json())` and the rest
 * compiles unchanged.
 *
 * At family scale this is fine; if the library ever grows past a few
 * thousand books, switch to paginated /api/books?cursor=... etc.
 */

import {
  bookFromRow, kidFromRow, reviewFromRow, readsByBook,
  handler, json, type Env, type ApiContext,
} from './_lib';

export const onRequestGet = handler(async (ctx: ApiContext) => {
  const env = ctx.env as Env;
  const db = env.DB;

  const [kids, books, reviews] = await Promise.all([
    db.prepare('SELECT id, name, age, interests, notes FROM kids ORDER BY name').all(),
    db.prepare(`
      SELECT isbn, title, author, authors_json, subjects_json, publish_year,
             cover_url, cover_r2_key, source, location,
             added_date, placed_on_shelf_at, last_shelf_stint
      FROM books
      ORDER BY added_date DESC
    `).all(),
    db.prepare(`
      SELECT id, kid_id, book_isbn, rating, liked, disliked, notes, date_read
      FROM reviews
      ORDER BY created_at DESC
    `).all(),
  ]);

  const readsMap = await readsByBook(db);

  return json({
    version: 4,
    kids: kids.results.map((r: any) => kidFromRow(r)),
    books: books.results.map((r: any) => bookFromRow(r, readsMap.get(r.isbn) ?? {})),
    reviews: reviews.results.map((r: any) => reviewFromRow(r)),
  });
});
