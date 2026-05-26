/**
 * POST /api/admin/import
 *
 * Accepts the legacy kids_library_v1 JSON export (the same blob
 * produced by the legacy app's Settings → Export button) and upserts
 * it into D1. Idempotent — re-running with the same blob produces
 * the same final state.
 *
 * Gating is entirely at Cloudflare Access (single source of truth):
 * the per-path Access app on `<host>/api/admin/*` only allows the
 * `principals` group. By the time this function runs, the request
 * has already cleared SSO + group membership + the JWT-verifying
 * middleware. No in-code email allowlist.
 *
 * Data shape conversions:
 *   - readsByKid:{kidId:count} → book_reads(kid_id, book_isbn, count)
 *   - cover: external URL (https://...) → cover_url
 *   - cover: data:image/jpeg;base64,... → decoded and uploaded to R2
 *     at covers/<isbn>.jpg, with cover_r2_key recorded on the book row.
 *     Photo-only books (typical for entries the user snapped on a
 *     phone with no title/author) wouldn't render at all if we dropped
 *     these — the image IS the entry.
 */

import {
  currentEmail, guardPreviewWrites, handler, json, jsonError, readJson,
  type ApiContext,
} from '../_lib';

interface LegacyExport {
  version?: number;
  kids: Array<{ id: string; name: string; age?: number; interests?: string; notes?: string }>;
  books: Array<{
    isbn: string; title?: string;
    authors?: string[]; subjects?: string[]; publishYear?: string;
    author?: string;  // older imports may have single-author
    cover?: string | null;
    source?: 'owned' | 'library'; location?: 'accessible' | 'backstock';
    addedDate?: string; placedOnShelfAt?: string | null;
    lastShelfStint?: any;
    readsByKid?: Record<string, number>;
  }>;
  reviews: Array<{
    id: string; kidId: string; bookIsbn: string; rating: number;
    liked?: string; disliked?: string; notes?: string; dateRead?: string;
  }>;
}

interface ImportSummary {
  kids: { inserted: number; updated: number };
  books: { inserted: number; updated: number; coversToR2: number; coversFailed: number };
  reads: { upserted: number };
  reviews: { inserted: number; updated: number };
}

interface DecodedDataUrl { mime: string; bytes: Uint8Array }

function parseDataUrl(s: string): DecodedDataUrl | null {
  // data:image/jpeg;base64,<base64> — accept any image/* MIME
  const m = s.match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) return null;
  try {
    const binary = atob(m[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime: m[1], bytes };
  } catch {
    return null;
  }
}

export const onRequestPost = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  // Caller is already a verified principal (per-path Access app gates
  // this prefix to the `principals` group). We just record their email
  // for created_by_email attribution.
  const email = currentEmail(ctx.request);

  const body = await readJson<LegacyExport>(ctx.request);
  if (!Array.isArray(body.kids) || !Array.isArray(body.books)) {
    return jsonError('not a kids_library export (missing kids/books arrays)', 400);
  }

  const summary: ImportSummary = {
    kids: { inserted: 0, updated: 0 },
    books: { inserted: 0, updated: 0, coversToR2: 0, coversFailed: 0 },
    reads: { upserted: 0 },
    reviews: { inserted: 0, updated: 0 },
  };

  const db = ctx.env.DB;

  // ---- Kids ----
  // Upsert by id. We don't track per-row before/after, so "inserted"
  // and "updated" are approximated by row existence at fetch time.
  const existingKidIds = new Set<string>(
    (await db.prepare('SELECT id FROM kids').all<{ id: string }>()).results.map((r) => r.id),
  );
  for (const k of body.kids) {
    if (!k.id || !k.name) continue;
    if (existingKidIds.has(k.id)) summary.kids.updated++; else summary.kids.inserted++;
    await db
      .prepare(`
        INSERT INTO kids (id, name, age, interests, notes, created_by_email)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          age = excluded.age,
          interests = excluded.interests,
          notes = excluded.notes
      `)
      .bind(k.id, k.name, k.age ?? null, k.interests ?? null, k.notes ?? null, email)
      .run();
  }

  // ---- Books ----
  const existingBookIsbns = new Set<string>(
    (await db.prepare('SELECT isbn FROM books').all<{ isbn: string }>()).results.map((r) => r.isbn),
  );
  for (const b of body.books) {
    if (!b.isbn) continue;
    if (existingBookIsbns.has(b.isbn)) summary.books.updated++; else summary.books.inserted++;

    let coverUrl: string | null = null;
    let coverR2Key: string | null = null;
    if (typeof b.cover === 'string') {
      if (b.cover.startsWith('data:')) {
        const decoded = parseDataUrl(b.cover);
        if (decoded) {
          const key = `covers/${b.isbn}.jpg`;
          try {
            await ctx.env.COVERS.put(key, decoded.bytes, {
              httpMetadata: { contentType: decoded.mime || 'image/jpeg' },
            });
            coverR2Key = key;
            summary.books.coversToR2++;
          } catch (e) {
            // Don't fail the whole import for one bad upload — record
            // and move on. The book row still lands without a cover.
            console.error('cover upload failed for', b.isbn, e);
            summary.books.coversFailed++;
          }
        } else {
          summary.books.coversFailed++;
        }
      } else {
        coverUrl = b.cover;
      }
    }

    const authors = Array.isArray(b.authors) && b.authors.length
      ? b.authors
      : (b.author ? [b.author] : []);
    const subjects = Array.isArray(b.subjects) ? b.subjects : [];

    await db
      .prepare(`
        INSERT INTO books
          (isbn, title, authors_json, subjects_json, publish_year, cover_url, cover_r2_key,
           source, location, added_date, placed_on_shelf_at, last_shelf_stint, created_by_email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(isbn) DO UPDATE SET
          title = excluded.title,
          authors_json = excluded.authors_json,
          subjects_json = excluded.subjects_json,
          publish_year = excluded.publish_year,
          cover_url = COALESCE(excluded.cover_url, books.cover_url),
          cover_r2_key = COALESCE(excluded.cover_r2_key, books.cover_r2_key),
          source = excluded.source,
          location = excluded.location,
          added_date = excluded.added_date,
          placed_on_shelf_at = excluded.placed_on_shelf_at,
          last_shelf_stint = excluded.last_shelf_stint,
          updated_at = datetime('now')
      `)
      .bind(
        b.isbn,
        b.title ?? null,
        authors.length ? JSON.stringify(authors) : null,
        subjects.length ? JSON.stringify(subjects) : null,
        b.publishYear ?? null,
        coverUrl,
        coverR2Key,
        b.source ?? 'owned',
        b.location ?? 'backstock',
        b.addedDate ?? new Date().toISOString(),
        b.placedOnShelfAt ?? null,
        b.lastShelfStint ? JSON.stringify(b.lastShelfStint) : null,
        email,
      )
      .run();

    // ---- Reads for this book ----
    for (const [kidId, countRaw] of Object.entries(b.readsByKid ?? {})) {
      const count = Number(countRaw);
      if (!Number.isFinite(count) || count <= 0) continue;
      summary.reads.upserted++;
      await db
        .prepare(`
          INSERT INTO book_reads (kid_id, book_isbn, count)
          VALUES (?, ?, ?)
          ON CONFLICT(kid_id, book_isbn) DO UPDATE SET
            count = excluded.count,
            updated_at = datetime('now')
        `)
        .bind(kidId, b.isbn, count)
        .run();
    }
  }

  // ---- Reviews ----
  const existingReviewIds = new Set<string>(
    (await db.prepare('SELECT id FROM reviews').all<{ id: string }>()).results.map((r) => r.id),
  );
  for (const r of body.reviews ?? []) {
    if (!r.id || !r.kidId || !r.bookIsbn) continue;
    if (existingReviewIds.has(r.id)) summary.reviews.updated++; else summary.reviews.inserted++;
    await db
      .prepare(`
        INSERT INTO reviews
          (id, kid_id, book_isbn, rating, liked, disliked, notes, date_read, created_by_email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          rating = excluded.rating,
          liked = excluded.liked,
          disliked = excluded.disliked,
          notes = excluded.notes,
          date_read = excluded.date_read
      `)
      .bind(
        r.id, r.kidId, r.bookIsbn, r.rating,
        r.liked ?? null, r.disliked ?? null, r.notes ?? null,
        r.dateRead ?? null, email,
      )
      .run();
  }

  return json({ ok: true, summary, importedBy: email });
});
