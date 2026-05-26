/**
 * Shared types + helpers for /api/* Pages Functions.
 *
 * Pages convention: files under functions/ starting with `_` are
 * treated as utility modules, not routes. So this file is safe to
 * import from siblings without exposing /api/_lib as a URL.
 */

export interface Env {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_APP_AUD: string;
  DB: D1Database;
  ISBN_CACHE: KVNamespace;
  COVERS: R2Bucket;
  /** For the OCR-cover-refine feature. Set via `wrangler pages secret put`. Unset = /api/books/[isbn]/refine returns 503. */
  ANTHROPIC_API_KEY?: string;
  /** Set by Cloudflare on every Pages build; we use it for the preview-write-guard. */
  CF_PAGES_BRANCH?: string;
}

export type ApiContext = EventContext<Env, string, Record<string, unknown>>;

/* ------------------------- JSON helpers ------------------------- */

export function json<T>(body: T, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers ?? {}),
    },
  });
}

export function jsonError(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

export async function readJson<T>(request: Request): Promise<T> {
  const ct = request.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new HttpError('expected application/json', 415);
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError('invalid json body', 400);
  }
}

export class HttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Wrap a handler so thrown HttpErrors become jsonErrors and everything else is a 500. */
export function handler(fn: (ctx: ApiContext) => Promise<Response>): (ctx: ApiContext) => Promise<Response> {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (e) {
      if (e instanceof HttpError) return jsonError(e.message, e.status);
      const msg = e instanceof Error ? e.message : 'internal error';
      // Log to Cloudflare's per-request log so it's visible in
      // `wrangler pages deployment tail`.
      console.error('api handler error:', msg, e);
      return jsonError('internal error', 500);
    }
  };
}

/* ------------------------- Auth helpers ------------------------- */

/** The verified email from Cf-Access-Authenticated-User-Email. Middleware already passed the JWT, so this is trustworthy. */
export function currentEmail(req: Request): string {
  return req.headers.get('Cf-Access-Authenticated-User-Email') ?? '';
}

/** Reject writes when running on a non-main preview branch — see web-hub/docs/data-storage.md. */
export function guardPreviewWrites(ctx: ApiContext): void {
  const method = ctx.request.method.toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  if (!isWrite) return;
  const branch = ctx.env.CF_PAGES_BRANCH;
  if (branch && branch !== 'main' && branch !== 'migration') {
    // Allow writes on `migration` while we're in the active migration
    // off the legacy localStorage app — that branch IS the development
    // preview that needs to be exercised. Once we deprecate and merge
    // migration → main, this becomes the standard "main-only" guard.
    throw new HttpError('preview branch: writes disabled', 403);
  }
}

/* ------------------------- ID helpers --------------------------- */

export function uid(): string {
  // 16 chars of url-safe random. Matches the legacy app's id shape
  // closely enough that imported rows blend in.
  return crypto.randomUUID().replaceAll('-', '').slice(0, 16);
}

/* ------------------------- Schema types ------------------------- */
// Wire-format types match the legacy localStorage shape as closely as
// possible so the frontend port stays minimal. Camel case throughout.

export interface Kid {
  id: string;
  name: string;
  age?: number | null;
  interests?: string | null;
  notes?: string | null;
}

export interface Book {
  isbn: string;
  title?: string | null;
  authors?: string[];                  // canonical: array. Legacy app stored authors as an array.
  subjects?: string[];                 // openlibrary tag list (e.g., "Picture books", "Friendship")
  publishYear?: string | null;
  cover?: string | null;               // resolved URL (external or /api/.../cover)
  source: 'owned' | 'library';
  location: 'accessible' | 'backstock';
  addedDate: string;
  placedOnShelfAt?: string | null;
  lastShelfStint?: ShelfStint | null;
  readsByKid: Record<string, number>;
}

export interface ShelfStint {
  placedAt: string | null;
  removedAt: string;
  outcome: 'keep' | 'hit' | 'ignored';
  readsAtRemoval: Record<string, number>;
}

export interface Review {
  id: string;
  kidId: string;
  bookIsbn: string;
  rating: number;
  liked?: string | null;
  disliked?: string | null;
  notes?: string | null;
  dateRead?: string | null;
}

/* ------------------------- D1 row mappers ----------------------- */

interface KidRow {
  id: string; name: string; age: number | null;
  interests: string | null; notes: string | null;
}

interface BookRow {
  isbn: string; title: string | null; author: string | null;
  authors_json: string | null; subjects_json: string | null; publish_year: string | null;
  cover_url: string | null; cover_r2_key: string | null;
  source: 'owned' | 'library'; location: 'accessible' | 'backstock';
  added_date: string; placed_on_shelf_at: string | null;
  last_shelf_stint: string | null;
}

interface ReviewRow {
  id: string; kid_id: string; book_isbn: string; rating: number;
  liked: string | null; disliked: string | null;
  notes: string | null; date_read: string | null;
}

interface BookReadRow {
  kid_id: string; book_isbn: string; count: number;
}

export function kidFromRow(r: KidRow): Kid {
  return {
    id: r.id, name: r.name, age: r.age,
    interests: r.interests, notes: r.notes,
  };
}

export function bookFromRow(
  r: BookRow,
  reads: Record<string, number>,
): Book {
  const cover = r.cover_r2_key ? `/api/books/${r.isbn}/cover` : r.cover_url;
  // Prefer JSON-array columns; fall back to the legacy single-author column for any pre-0002 rows.
  const authors = r.authors_json
    ? (JSON.parse(r.authors_json) as string[])
    : r.author ? [r.author] : [];
  const subjects = r.subjects_json ? (JSON.parse(r.subjects_json) as string[]) : [];
  return {
    isbn: r.isbn, title: r.title, authors, subjects,
    publishYear: r.publish_year, cover,
    source: r.source, location: r.location,
    addedDate: r.added_date,
    placedOnShelfAt: r.placed_on_shelf_at,
    lastShelfStint: r.last_shelf_stint ? JSON.parse(r.last_shelf_stint) : null,
    readsByKid: reads,
  };
}

export function reviewFromRow(r: ReviewRow): Review {
  return {
    id: r.id, kidId: r.kid_id, bookIsbn: r.book_isbn,
    rating: r.rating, liked: r.liked, disliked: r.disliked,
    notes: r.notes, dateRead: r.date_read,
  };
}

/** Build readsByKid map for all books, keyed by isbn. */
export async function readsByBook(db: D1Database): Promise<Map<string, Record<string, number>>> {
  const { results } = await db
    .prepare('SELECT kid_id, book_isbn, count FROM book_reads')
    .all<BookReadRow>();
  const out = new Map<string, Record<string, number>>();
  for (const r of results) {
    let m = out.get(r.book_isbn);
    if (!m) { m = {}; out.set(r.book_isbn, m); }
    m[r.kid_id] = r.count;
  }
  return out;
}
