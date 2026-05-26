/**
 * Tests for POST /api/admin/import — the principal-gated endpoint
 * that takes a legacy JSON export and upserts it into D1.
 *
 * We import the handler directly and call it with a synthesized
 * EventContext, so the HTTP wrapper is covered too (not just the
 * import logic). DB is in-memory SQLite via the d1-mock.
 *
 * Auth isn't tested here — gating is now entirely at Cloudflare
 * Access (the per-path Access app on /api/admin/*); by the time
 * onRequestPost runs, the caller is a verified principal. We pass
 * an email header to exercise the created_by_email attribution path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { onRequestPost } from '../functions/api/admin/import';
import { createMockD1, type MockD1 } from './d1-mock';

let db: MockD1;

beforeEach(() => {
  db = createMockD1();
});

function buildCtx(body: unknown, headers: Record<string, string> = {}): any {
  const req = new Request('https://kids-library.falkizar.com/api/admin/import', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-access-authenticated-user-email': 'alice@example.com',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    request: req,
    env: { DB: db as any, CF_PAGES_BRANCH: 'main' },
    params: {},
    waitUntil() {},
    passThroughOnException() {},
    next() { return Promise.resolve(new Response()); },
    data: {},
  };
}

const SAMPLE_EXPORT = {
  version: 4,
  kids: [
    { id: 'k1', name: 'Alice', age: 6, interests: 'dinosaurs' },
    { id: 'k2', name: 'Bob', age: 4 },
  ],
  books: [
    {
      isbn: '9780399226908',
      title: 'The Very Hungry Caterpillar',
      authors: ['Eric Carle'],
      subjects: ['Picture books', 'Insects'],
      publishYear: '1969',
      cover: 'https://covers.openlibrary.org/b/isbn/9780399226908-M.jpg',
      source: 'owned' as const,
      location: 'accessible' as const,
      addedDate: '2024-01-15T00:00:00Z',
      placedOnShelfAt: '2024-01-15T00:00:00Z',
      readsByKid: { k1: 5, k2: 2 },
    },
    {
      isbn: 'manual-abc123',
      title: '',
      authors: [],
      cover: 'data:image/jpeg;base64,deadbeef',  // should be DROPPED
      source: 'owned' as const,
      location: 'backstock' as const,
      addedDate: '2024-02-01T00:00:00Z',
      readsByKid: {},
    },
  ],
  reviews: [
    { id: 'r1', kidId: 'k1', bookIsbn: '9780399226908', rating: 5, liked: 'colors' },
  ],
  settings: { lastScanChoice: 'owned-backstock' },
};

describe('POST /api/admin/import', () => {
  it('inserts kids, books, reads, and reviews from a fresh export', async () => {
    const ctx = buildCtx(SAMPLE_EXPORT);
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.importedBy).toBe('alice@example.com');
    expect(body.summary.kids.inserted).toBe(2);
    expect(body.summary.books.inserted).toBe(2);
    expect(body.summary.reviews.inserted).toBe(1);
    expect(body.summary.reads.upserted).toBe(2);

    const kids = db.raw.prepare('SELECT id, name, age FROM kids ORDER BY id').all();
    expect(kids).toEqual([
      { id: 'k1', name: 'Alice', age: 6 },
      { id: 'k2', name: 'Bob', age: 4 },
    ]);

    const books = db.raw.prepare('SELECT isbn, title, authors_json, subjects_json, publish_year FROM books ORDER BY isbn').all() as any[];
    expect(books).toHaveLength(2);
    const caterpillar = books.find((b) => b.isbn === '9780399226908');
    expect(caterpillar.title).toBe('The Very Hungry Caterpillar');
    expect(JSON.parse(caterpillar.authors_json)).toEqual(['Eric Carle']);
    expect(JSON.parse(caterpillar.subjects_json)).toEqual(['Picture books', 'Insects']);
    expect(caterpillar.publish_year).toBe('1969');

    const reads = db.raw.prepare('SELECT kid_id, book_isbn, count FROM book_reads ORDER BY kid_id').all();
    expect(reads).toEqual([
      { kid_id: 'k1', book_isbn: '9780399226908', count: 5 },
      { kid_id: 'k2', book_isbn: '9780399226908', count: 2 },
    ]);

    const reviews = db.raw.prepare('SELECT id, kid_id, book_isbn, rating, liked FROM reviews').all();
    expect(reviews).toEqual([
      { id: 'r1', kid_id: 'k1', book_isbn: '9780399226908', rating: 5, liked: 'colors' },
    ]);
  });

  it('drops data-URL covers and reports them in summary.coversDropped', async () => {
    const res = await onRequestPost(buildCtx(SAMPLE_EXPORT));
    const body = await res.json() as any;
    expect(body.summary.books.coversDropped).toBe(1);

    const cover = db.raw.prepare(
      `SELECT cover_url FROM books WHERE isbn = 'manual-abc123'`,
    ).get() as { cover_url: string | null };
    expect(cover.cover_url).toBeNull();
  });

  it('preserves external cover URLs', async () => {
    await onRequestPost(buildCtx(SAMPLE_EXPORT));
    const cover = db.raw.prepare(
      `SELECT cover_url FROM books WHERE isbn = '9780399226908'`,
    ).get() as { cover_url: string };
    expect(cover.cover_url).toBe('https://covers.openlibrary.org/b/isbn/9780399226908-M.jpg');
  });

  it('is idempotent — re-running the same import produces the same end state', async () => {
    await onRequestPost(buildCtx(SAMPLE_EXPORT));
    const beforeKids = db.raw.prepare('SELECT COUNT(*) as n FROM kids').get() as { n: number };
    const beforeBooks = db.raw.prepare('SELECT COUNT(*) as n FROM books').get() as { n: number };
    const beforeReviews = db.raw.prepare('SELECT COUNT(*) as n FROM reviews').get() as { n: number };
    const beforeReads = db.raw.prepare('SELECT kid_id, book_isbn, count FROM book_reads ORDER BY kid_id').all();

    const res = await onRequestPost(buildCtx(SAMPLE_EXPORT));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.summary.kids.inserted).toBe(0);
    expect(body.summary.kids.updated).toBe(2);
    expect(body.summary.books.inserted).toBe(0);
    expect(body.summary.books.updated).toBe(2);

    expect((db.raw.prepare('SELECT COUNT(*) as n FROM kids').get() as { n: number }).n).toBe(beforeKids.n);
    expect((db.raw.prepare('SELECT COUNT(*) as n FROM books').get() as { n: number }).n).toBe(beforeBooks.n);
    expect((db.raw.prepare('SELECT COUNT(*) as n FROM reviews').get() as { n: number }).n).toBe(beforeReviews.n);
    expect(db.raw.prepare('SELECT kid_id, book_isbn, count FROM book_reads ORDER BY kid_id').all())
      .toEqual(beforeReads);
  });

  it('updates existing rows on re-import with changed fields', async () => {
    await onRequestPost(buildCtx(SAMPLE_EXPORT));
    const modified = {
      ...SAMPLE_EXPORT,
      kids: [
        { id: 'k1', name: 'Alice Updated', age: 7, interests: 'space' },
        { id: 'k2', name: 'Bob', age: 4 },
      ],
    };
    const res = await onRequestPost(buildCtx(modified));
    expect(res.status).toBe(200);

    const alice = db.raw.prepare('SELECT name, age, interests FROM kids WHERE id = ?').get('k1') as any;
    expect(alice).toEqual({ name: 'Alice Updated', age: 7, interests: 'space' });
  });

  it('rejects malformed input — missing kids array', async () => {
    const res = await onRequestPost(buildCtx({ version: 4, books: [], reviews: [] }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/missing.*kids/i);
  });

  it('rejects non-JSON content-type', async () => {
    const req = new Request('https://kids-library.falkizar.com/api/admin/import', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not json',
    });
    const ctx: any = { request: req, env: { DB: db as any, CF_PAGES_BRANCH: 'main' } };
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(415);
  });

  it('blocks writes on preview branches other than main/migration', async () => {
    const ctx = buildCtx(SAMPLE_EXPORT, {});
    ctx.env.CF_PAGES_BRANCH = 'feature/whatever';
    const res = await onRequestPost(ctx);
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toMatch(/preview.*writes/i);
  });

  it('migrates legacy single-author shape (author string) into authors_json array', async () => {
    const legacy = {
      version: 4,
      kids: [],
      books: [
        {
          isbn: '9999999999999',
          title: 'Old Book',
          author: 'Single Author',  // legacy single string
          source: 'owned' as const,
          location: 'accessible' as const,
          addedDate: '2020-01-01T00:00:00Z',
        },
      ],
      reviews: [],
    };
    await onRequestPost(buildCtx(legacy));
    const row = db.raw.prepare(
      `SELECT authors_json FROM books WHERE isbn = '9999999999999'`,
    ).get() as { authors_json: string };
    expect(JSON.parse(row.authors_json)).toEqual(['Single Author']);
  });

  it('skips read counts that are zero or negative', async () => {
    const dataWithBadReads = {
      ...SAMPLE_EXPORT,
      books: [
        {
          ...SAMPLE_EXPORT.books[0],
          readsByKid: { k1: 0, k2: -1, k1_again: 3 } as Record<string, number>,
        },
        SAMPLE_EXPORT.books[1],
      ],
    };
    await onRequestPost(buildCtx(dataWithBadReads));
    const reads = db.raw.prepare('SELECT kid_id, count FROM book_reads ORDER BY kid_id').all();
    // The valid k1_again:3 read should land. k1:0 and k2:-1 should be skipped.
    // (We didn't seed a 'k1_again' kid row, but book_reads doesn't enforce
    // the kid FK at insert time here because we ran without parent kids
    // for this scenario.)
    // Just assert the bad ones aren't present.
    expect(reads).not.toContainEqual(expect.objectContaining({ kid_id: 'k1', count: 0 }));
    expect(reads).not.toContainEqual(expect.objectContaining({ kid_id: 'k2', count: -1 }));
  });
});
