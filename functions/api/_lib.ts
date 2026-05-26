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
  /** Comma-separated list of emails allowed to call /api/admin/*. Set via Pages env vars; unset = no one can import. */
  PRINCIPAL_EMAILS?: string;
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

/** Throw 403 unless the caller's email is in env.PRINCIPAL_EMAILS. Used for /api/admin/*. */
export function requirePrincipal(ctx: ApiContext): string {
  const email = currentEmail(ctx.request);
  const allowed = (ctx.env.PRINCIPAL_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.length) {
    // Fail closed: if the env var isn't set, no one is a principal.
    throw new HttpError('principal allowlist not configured', 503);
  }
  if (!allowed.includes(email.toLowerCase())) {
    throw new HttpError('forbidden', 403);
  }
  return email;
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
  author?: string | null;
  cover?: string | null;         // resolved URL (external or /api/.../cover)
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
  return {
    isbn: r.isbn, title: r.title, author: r.author, cover,
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
