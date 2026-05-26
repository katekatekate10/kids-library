/**
 * Tests for POST /api/books/[isbn]/refine — the Claude-vision-based
 * cover-OCR endpoint.
 *
 * Both Anthropic and openlibrary are external; tests stub the global
 * fetch and assert the right shape went out + the right shape comes
 * back. The book's cover is loaded from R2 via the mock COVERS
 * binding.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { onRequestPost } from '../functions/api/books/[isbn]/refine';
import { createMockD1, type MockD1 } from './d1-mock';

let db: MockD1;
let covers: MockR2;

interface MockR2 {
  objects: Map<string, { bytes: Uint8Array; contentType?: string }>;
  put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  get(key: string): Promise<MockR2Object | null>;
}
interface MockR2Object {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBufferLike>;
  httpMetadata?: { contentType?: string };
}

function createMockR2(): MockR2 {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    objects,
    async put(key, value, opts) {
      objects.set(key, { bytes: value, contentType: opts?.httpMetadata?.contentType });
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        body: new ReadableStream(),
        async arrayBuffer() { return o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength); },
        httpMetadata: { contentType: o.contentType },
      };
    },
  };
}

function buildCtx(isbn: string, env: Record<string, unknown> = {}): any {
  return {
    request: new Request(`https://kids-library.falkizar.com/api/books/${isbn}/refine`, {
      method: 'POST',
      headers: { 'cf-access-authenticated-user-email': 'alice@example.com' },
    }),
    env: {
      DB: db as any,
      COVERS: covers as any,
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
      CF_PAGES_BRANCH: 'main',
      ...env,
    },
    params: { isbn },
    waitUntil() {},
    passThroughOnException() {},
    next() { return Promise.resolve(new Response()); },
    data: {},
  };
}

/** Pre-populate D1 with one photo-only book + its cover in R2. */
async function seedPhotoBook(isbn = 'manual-test', coverBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
  await db
    .prepare(`
      INSERT INTO books (isbn, title, source, location, added_date, cover_r2_key)
      VALUES (?, '', 'owned', 'backstock', '2024-01-01T00:00:00Z', ?)
    `)
    .bind(isbn, `covers/${isbn}.jpg`).run();
  await covers.put(`covers/${isbn}.jpg`, coverBytes, { httpMetadata: { contentType: 'image/png' } });
}

/** Build a Claude-API-style success response containing a JSON string. */
function claudeJsonResponse(jsonPayload: object | null) {
  const body = jsonPayload == null ? 'null' : JSON.stringify(jsonPayload);
  return new Response(JSON.stringify({
    content: [{ type: 'text', text: body }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  db = createMockD1();
  covers = createMockR2();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/books/[isbn]/refine', () => {
  it('returns 503 when ANTHROPIC_API_KEY is not configured', async () => {
    await seedPhotoBook();
    const res = await onRequestPost(buildCtx('manual-test', { ANTHROPIC_API_KEY: '' }));
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/refine not configured/);
  });

  it('returns 404 when the book does not exist', async () => {
    const res = await onRequestPost(buildCtx('does-not-exist'));
    expect(res.status).toBe(404);
  });

  it('returns 400 when the book has no uploaded cover', async () => {
    await db
      .prepare(`
        INSERT INTO books (isbn, title, source, location, added_date)
        VALUES ('no-cover-book', 'Test', 'owned', 'backstock', '2024-01-01T00:00:00Z')
      `).run();
    const res = await onRequestPost(buildCtx('no-cover-book'));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/no uploaded cover/);
  });

  it('happy path: extracts metadata and finds ISBN candidates', async () => {
    await seedPhotoBook();

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('api.anthropic.com')) {
          return claudeJsonResponse({
            title: 'The Very Hungry Caterpillar',
            author: 'Eric Carle',
            illustrator: 'Eric Carle',
            confidence: 'high',
          });
        }
        if (url.includes('openlibrary.org/search.json')) {
          return new Response(JSON.stringify({
            docs: [{
              title: 'The Very Hungry Caterpillar',
              author_name: ['Eric Carle'],
              isbn: ['9780399226908', '0399226907'],
              cover_i: 12345,
            }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error('unexpected fetch: ' + url);
      });

    const res = await onRequestPost(buildCtx('manual-test'));
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.extracted).toEqual({
      title: 'The Very Hungry Caterpillar',
      author: 'Eric Carle',
      illustrator: 'Eric Carle',
      confidence: 'high',
    });
    expect(body.isbnCandidates).toHaveLength(1);
    expect(body.isbnCandidates[0]).toMatchObject({
      isbn: '9780399226908',  // prefers 13-digit
      title: 'The Very Hungry Caterpillar',
      author: 'Eric Carle',
    });
    expect(body.model).toBe('claude-haiku-4-5-20251001');

    // Anthropic call included the image as base64
    const anthropicCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('anthropic.com'));
    expect(anthropicCall).toBeDefined();
    const init = anthropicCall![1] as RequestInit;
    expect((init.headers as any)['x-api-key']).toBe('sk-ant-test-key');
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe('claude-haiku-4-5-20251001');
    const imgPart = sent.messages[0].content.find((c: any) => c.type === 'image');
    expect(imgPart.source.type).toBe('base64');
    expect(imgPart.source.media_type).toBe('image/png');
    expect(imgPart.source.data).toMatch(/^[A-Za-z0-9+/]+=*$/);  // valid base64
  });

  it('returns extracted=null and empty candidates when the model returns "null"', async () => {
    await seedPhotoBook();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(claudeJsonResponse(null));

    const res = await onRequestPost(buildCtx('manual-test'));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.extracted).toBeNull();
    expect(body.isbnCandidates).toEqual([]);
  });

  it('treats non-JSON model output as a failed extraction (extracted=null) rather than 500', async () => {
    await seedPhotoBook();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'I cannot read this cover, sorry.' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = await onRequestPost(buildCtx('manual-test'));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.extracted).toBeNull();
  });

  it('strips ```json fences when the model wraps its output', async () => {
    await seedPhotoBook();
    // mockImplementation (not mockResolvedValue) so each fetch call
    // gets a fresh Response — otherwise the openlibrary call after
    // anthropic would try to read an already-consumed body.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('anthropic.com')) {
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: '```json\n{"title":"Foo","author":"Bar","illustrator":null,"confidence":"high"}\n```' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ docs: [] }), { status: 200 });
    });

    const res = await onRequestPost(buildCtx('manual-test'));
    const body = await res.json() as any;
    expect(body.extracted.title).toBe('Foo');
    expect(body.extracted.author).toBe('Bar');
  });

  it('clamps unknown confidence values to "low"', async () => {
    await seedPhotoBook();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('anthropic.com')) {
        return claudeJsonResponse({
          title: 'X', author: 'Y', illustrator: null, confidence: 'extremely-high-trust-me',
        });
      }
      return new Response(JSON.stringify({ docs: [] }), { status: 200 });
    });

    const res = await onRequestPost(buildCtx('manual-test'));
    const body = await res.json() as any;
    expect(body.extracted.confidence).toBe('low');
  });

  it('skips openlibrary lookup when extracted has no title and no author', async () => {
    await seedPhotoBook();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(claudeJsonResponse({
      title: null, author: null, illustrator: null, confidence: 'low',
    }));

    const res = await onRequestPost(buildCtx('manual-test'));
    const body = await res.json() as any;
    expect(body.isbnCandidates).toEqual([]);
    // Only the Anthropic call should have been made.
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes('openlibrary'))).toHaveLength(0);
  });

  it('returns empty candidates if openlibrary has no matches', async () => {
    await seedPhotoBook();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('anthropic.com')) {
        return claudeJsonResponse({ title: 'Obscure Book', author: 'Nobody', illustrator: null, confidence: 'medium' });
      }
      return new Response(JSON.stringify({ docs: [] }), { status: 200 });
    });

    const res = await onRequestPost(buildCtx('manual-test'));
    const body = await res.json() as any;
    expect(body.extracted.title).toBe('Obscure Book');
    expect(body.isbnCandidates).toEqual([]);
  });

  it('blocks writes on preview branches other than main/migration', async () => {
    await seedPhotoBook();
    const res = await onRequestPost(buildCtx('manual-test', { CF_PAGES_BRANCH: 'feature/whatever' }));
    expect(res.status).toBe(403);
  });

  it('surfaces Anthropic API failures as 500 with a useful message', async () => {
    await seedPhotoBook();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":{"type":"overloaded","message":"too busy"}}', {
      status: 529,
      headers: { 'content-type': 'application/json' },
    }));

    const res = await onRequestPost(buildCtx('manual-test'));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('internal error');
  });
});
