/**
 * Tests for POST /api/books/[isbn]/rekey — the PK rename used after
 * OCR identifies a real ISBN for a previously photo-only (manual-*)
 * book.
 *
 * Verifies the atomic D1 batch: book row carries forward all fields
 * under the new PK, book_reads and reviews FKs repoint, old row goes
 * away, R2 cover object is moved.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { onRequestPost } from '../functions/api/books/[isbn]/rekey';
import { createMockD1, type MockD1 } from './d1-mock';

let db: MockD1;
let covers: MockR2;

interface MockR2 {
  objects: Map<string, { bytes: Uint8Array; contentType?: string }>;
  put(key: string, value: any, opts?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  get(key: string): Promise<MockR2Object | null>;
  delete(key: string): Promise<void>;
}
interface MockR2Object {
  body: any;
  arrayBuffer(): Promise<ArrayBufferLike>;
  httpMetadata?: { contentType?: string };
}

function createMockR2(): MockR2 {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    objects,
    async put(key, value, opts) {
      // value may be a Uint8Array, an ArrayBuffer, or our MockR2Object's `body`.
      // For tests we only put Uint8Array (seed) or re-put the body we just got.
      let bytes: Uint8Array;
      if (value instanceof Uint8Array) bytes = value;
      else if (value && typeof value === 'object' && 'sourceKey' in value) {
        const src = objects.get((value as any).sourceKey);
        bytes = src?.bytes ?? new Uint8Array();
      } else {
        bytes = new Uint8Array();
      }
      objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        // Return a marker `body` that put() understands, so re-putting
        // the same body copies the underlying bytes. Pages worker code
        // uses obj.body directly; in tests we don't care about the stream.
        body: { sourceKey: key },
        async arrayBuffer() { return o.bytes.buffer; },
        httpMetadata: { contentType: o.contentType },
      };
    },
    async delete(key) { objects.delete(key); },
  };
}

function buildCtx(isbn: string, body: unknown, envOverrides: Record<string, unknown> = {}): any {
  return {
    request: new Request(`https://kids-library.falkizar.com/api/books/${isbn}/rekey`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env: { DB: db as any, COVERS: covers as any, CF_PAGES_BRANCH: 'main', ...envOverrides },
    params: { isbn },
    waitUntil() {},
    passThroughOnException() {},
    next() { return Promise.resolve(new Response()); },
    data: {},
  };
}

async function seedFullPhotoBook(opts: { isbn: string; withCover?: boolean; withReads?: boolean; withReviews?: boolean } = { isbn: 'manual-old' }) {
  const isbn = opts.isbn;
  await db.prepare(`
    INSERT INTO books (isbn, title, authors_json, source, location, added_date, cover_r2_key, last_shelf_stint)
    VALUES (?, 'Old Title', '["Old Author"]', 'owned', 'accessible', '2024-01-01T00:00:00Z', ?, '{"placedAt":"2024-01-01","removedAt":"2024-02-01","outcome":"hit","readsAtRemoval":{}}')
  `).bind(isbn, opts.withCover === false ? null : `covers/${isbn}.jpg`).run();

  if (opts.withCover !== false) {
    await covers.put(`covers/${isbn}.jpg`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { httpMetadata: { contentType: 'image/jpeg' } });
  }
  if (opts.withReads) {
    await db.prepare(`INSERT INTO kids (id, name) VALUES ('k1', 'Alice')`).run();
    await db.prepare(`INSERT INTO book_reads (kid_id, book_isbn, count) VALUES ('k1', ?, 5)`).bind(isbn).run();
  }
  if (opts.withReviews) {
    // reviews need a kid to FK to
    await db.prepare(`INSERT OR IGNORE INTO kids (id, name) VALUES ('k1', 'Alice')`).run();
    await db.prepare(`
      INSERT INTO reviews (id, kid_id, book_isbn, rating, liked)
      VALUES ('r1', 'k1', ?, 5, 'colors')
    `).bind(isbn).run();
  }
}

beforeEach(() => {
  db = createMockD1();
  covers = createMockR2();
});

describe('POST /api/books/[isbn]/rekey', () => {
  it('renames PK and carries title/authors/cover_r2_key forward', async () => {
    await seedFullPhotoBook({ isbn: 'manual-old', withCover: true });

    const res = await onRequestPost(buildCtx('manual-old', { newIsbn: '9780399226908' }));
    expect(res.status).toBe(200);

    const oldRow = db.raw.prepare(`SELECT 1 FROM books WHERE isbn = 'manual-old'`).get();
    const newRow = db.raw.prepare(`SELECT title, authors_json, cover_r2_key FROM books WHERE isbn = '9780399226908'`).get() as any;
    expect(oldRow).toBeUndefined();
    expect(newRow.title).toBe('Old Title');
    expect(newRow.authors_json).toBe('["Old Author"]');
    expect(newRow.cover_r2_key).toBe('covers/9780399226908.jpg');
  });

  it('repoints book_reads FKs to the new ISBN', async () => {
    await seedFullPhotoBook({ isbn: 'manual-old', withReads: true });

    const res = await onRequestPost(buildCtx('manual-old', { newIsbn: '9780399226908' }));
    expect(res.status).toBe(200);

    const oldReads = db.raw.prepare(`SELECT COUNT(*) as n FROM book_reads WHERE book_isbn = 'manual-old'`).get() as { n: number };
    const newReads = db.raw.prepare(`SELECT kid_id, count FROM book_reads WHERE book_isbn = '9780399226908'`).all();
    expect(oldReads.n).toBe(0);
    expect(newReads).toEqual([{ kid_id: 'k1', count: 5 }]);
  });

  it('repoints reviews FKs to the new ISBN', async () => {
    await seedFullPhotoBook({ isbn: 'manual-old', withReviews: true });

    const res = await onRequestPost(buildCtx('manual-old', { newIsbn: '9780399226908' }));
    expect(res.status).toBe(200);

    const oldReviews = db.raw.prepare(`SELECT COUNT(*) as n FROM reviews WHERE book_isbn = 'manual-old'`).get() as { n: number };
    const newReviews = db.raw.prepare(`SELECT id, liked FROM reviews WHERE book_isbn = '9780399226908'`).all();
    expect(oldReviews.n).toBe(0);
    expect(newReviews).toEqual([{ id: 'r1', liked: 'colors' }]);
  });

  it('moves the R2 cover object to the new key', async () => {
    await seedFullPhotoBook({ isbn: 'manual-old', withCover: true });

    const res = await onRequestPost(buildCtx('manual-old', { newIsbn: '9780399226908' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { coverMoved: boolean };
    expect(body.coverMoved).toBe(true);

    expect(covers.objects.has('covers/manual-old.jpg')).toBe(false);
    expect(covers.objects.has('covers/9780399226908.jpg')).toBe(true);
  });

  it('works when there is no cover (cover_r2_key is null)', async () => {
    await seedFullPhotoBook({ isbn: 'manual-old', withCover: false });

    const res = await onRequestPost(buildCtx('manual-old', { newIsbn: '9780399226908' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { coverMoved: boolean };
    expect(body.coverMoved).toBe(false);

    const newRow = db.raw.prepare(`SELECT cover_r2_key FROM books WHERE isbn = '9780399226908'`).get() as { cover_r2_key: string | null };
    expect(newRow.cover_r2_key).toBeNull();
  });

  it('rejects when the new ISBN already exists', async () => {
    await seedFullPhotoBook({ isbn: 'manual-old' });
    await db.prepare(`
      INSERT INTO books (isbn, title, source, location, added_date)
      VALUES ('9780399226908', 'Already Here', 'owned', 'accessible', '2024-01-01T00:00:00Z')
    `).run();

    const res = await onRequestPost(buildCtx('manual-old', { newIsbn: '9780399226908' }));
    expect(res.status).toBe(409);
  });

  it('rejects when newIsbn equals current isbn', async () => {
    await seedFullPhotoBook({ isbn: 'manual-old' });
    const res = await onRequestPost(buildCtx('manual-old', { newIsbn: 'manual-old' }));
    expect(res.status).toBe(400);
  });

  it('rejects empty newIsbn', async () => {
    await seedFullPhotoBook({ isbn: 'manual-old' });
    const res = await onRequestPost(buildCtx('manual-old', { newIsbn: '' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the book does not exist', async () => {
    const res = await onRequestPost(buildCtx('does-not-exist', { newIsbn: '9780399226908' }));
    expect(res.status).toBe(404);
  });

  it('blocks writes on preview branches other than main/migration', async () => {
    await seedFullPhotoBook({ isbn: 'manual-old' });
    const res = await onRequestPost(buildCtx('manual-old', { newIsbn: '9780399226908' }, { CF_PAGES_BRANCH: 'feature/x' }));
    expect(res.status).toBe(403);
  });
});
