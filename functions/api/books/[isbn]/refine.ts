/**
 * POST /api/books/[isbn]/refine
 *
 * Pulls a book's cover from R2, asks Claude Haiku 4.5 vision to
 * extract structured metadata (title / author / illustrator /
 * confidence), then optionally looks up ISBN candidates from
 * openlibrary by title+author. Returns suggestions; the caller
 * confirms before any DB write happens.
 *
 *   request:  no body needed (the ISBN is the path param)
 *   response: {
 *     extracted: {
 *       title: string | null,
 *       author: string | null,
 *       illustrator: string | null,
 *       confidence: 'high' | 'medium' | 'low'
 *     } | null,            // null = model couldn't read the cover
 *     isbnCandidates: [    // empty array if extraction failed or no matches
 *       { isbn: string, title: string, author: string, cover?: string }
 *     ],
 *     model: string,       // e.g. "claude-haiku-4-5-20251001"
 *   }
 *
 * Why Claude (vs Cloudflare Workers AI / OpenAI / pure OCR):
 * children's book covers use stylized fonts, hand-lettering, and
 * have illustrator credits in irregular positions. A vision-language
 * model that can reason about "what is the title here" outperforms
 * raw OCR. We picked Claude Haiku 4.5 specifically because its
 * cost is trivial at our scale (~$0.001/image, ~$0.08/year) and
 * its vision performance on stylized typography is consistently
 * strong. The model id below is the one variable that changes if
 * we ever swap providers.
 */

import {
  guardPreviewWrites, handler, json, jsonError, type ApiContext,
} from '../../_lib';

const MODEL = 'claude-haiku-4-5-20251001';

interface ClaudeMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
}

interface Extracted {
  title: string | null;
  author: string | null;
  illustrator: string | null;
  confidence: 'high' | 'medium' | 'low';
}

interface IsbnCandidate {
  isbn: string;
  title: string;
  author: string;
  cover?: string;
}

export const onRequestPost = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const isbn = ctx.params.isbn as string;
  const env = ctx.env;

  if (!env.ANTHROPIC_API_KEY) {
    return jsonError(
      'refine not configured: ANTHROPIC_API_KEY missing — set via wrangler pages secret put',
      503,
    );
  }

  // 1. Verify the book exists and has a cover in R2.
  const book = await env.DB
    .prepare('SELECT isbn, title, cover_r2_key FROM books WHERE isbn = ?')
    .bind(isbn)
    .first<{ isbn: string; title: string | null; cover_r2_key: string | null }>();
  if (!book) return jsonError('book not found', 404);
  if (!book.cover_r2_key) {
    return jsonError('book has no uploaded cover to refine from', 400);
  }

  const cover = await env.COVERS.get(book.cover_r2_key);
  if (!cover) return jsonError('cover object missing from R2', 500);

  const bytes = new Uint8Array(await cover.arrayBuffer());
  const mime = cover.httpMetadata?.contentType ?? 'image/jpeg';
  const base64 = arrayBufferToBase64(bytes);

  // 2. Ask Claude to extract metadata.
  const extracted = await callClaudeVision(env.ANTHROPIC_API_KEY, base64, mime);

  // 3. If extraction has anything, look up ISBN candidates.
  let isbnCandidates: IsbnCandidate[] = [];
  if (extracted && (extracted.title || extracted.author)) {
    isbnCandidates = await findIsbnCandidates(extracted.title, extracted.author);
  }

  return json({ extracted, isbnCandidates, model: MODEL });
});

/** Single shot to Claude, asking for structured JSON. */
async function callClaudeVision(
  apiKey: string,
  base64: string,
  mime: string,
): Promise<Extracted | null> {
  const prompt = [
    "Look at this children's book cover.",
    "Return ONLY a JSON object in this exact shape:",
    '{"title": "...", "author": "...", "illustrator": "...", "confidence": "high"|"medium"|"low"}',
    "",
    "Rules:",
    "- title: the main book title (the most prominent text). Strip subtitles unless they're inseparable from the title.",
    "- author: the author's name. If multiple, comma-separated. Null if not visible.",
    "- illustrator: name only if separately credited as 'illustrated by' or equivalent. Otherwise null.",
    "- confidence: 'high' when title AND author are clearly readable; 'medium' when one is uncertain; 'low' when you're guessing.",
    "- Return any field as null if you cannot identify it.",
    "- If you cannot read the cover at all, return null instead of an object.",
    "- Do not include any text outside the JSON.",
  ].join('\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  });

  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Anthropic API ${r.status}: ${errBody.slice(0, 200)}`);
  }
  const body = (await r.json()) as ClaudeMessagesResponse;
  if (body.error) throw new Error(`Anthropic API error: ${body.error.message}`);

  const text = body.content?.find((c) => c.type === 'text')?.text?.trim();
  if (!text) return null;

  // The model occasionally wraps JSON in ```json ... ``` fences despite
  // the prompt. Strip fences before parsing.
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  // The model is also allowed to return the literal string "null" if it
  // couldn't read the cover.
  if (stripped === 'null') return null;

  try {
    const parsed = JSON.parse(stripped) as Partial<Extracted>;
    const conf = parsed.confidence;
    return {
      title: parsed.title ?? null,
      author: parsed.author ?? null,
      illustrator: parsed.illustrator ?? null,
      confidence: conf === 'high' || conf === 'medium' || conf === 'low' ? conf : 'low',
    };
  } catch {
    // Model returned non-JSON. Treat as failed extraction rather than 500
    // — the user can still manually edit on the suggestion screen.
    return null;
  }
}

/** Look up ISBNs by title and author from openlibrary. Returns top 5 most-likely matches. */
async function findIsbnCandidates(title: string | null, author: string | null): Promise<IsbnCandidate[]> {
  const params = new URLSearchParams();
  if (title) params.set('title', title);
  if (author) params.set('author', author);
  params.set('limit', '5');
  params.set('fields', 'title,author_name,isbn,cover_i,first_publish_year');

  const r = await fetch(`https://openlibrary.org/search.json?${params}`);
  if (!r.ok) return [];
  const j = (await r.json()) as { docs?: Array<{
    title: string;
    author_name?: string[];
    isbn?: string[];
    cover_i?: number;
  }> };

  const out: IsbnCandidate[] = [];
  for (const doc of j.docs ?? []) {
    if (!doc.isbn?.length) continue;
    // openlibrary returns many ISBNs (one per edition); take the first
    // 13-digit one (978/979 prefix) since that's what the legacy app expects.
    const isbn13 = doc.isbn.find((x) => /^97[89]\d{10}$/.test(x)) ?? doc.isbn[0];
    out.push({
      isbn: isbn13,
      title: doc.title,
      author: doc.author_name?.join(', ') ?? '',
      cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : undefined,
    });
    if (out.length >= 5) break;
  }
  return out;
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  // btoa expects a "binary string". Chunk to avoid call-stack-limit on large covers.
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}
