import {
  currentEmail, guardPreviewWrites, handler, json, jsonError,
  readJson, reviewFromRow, uid, type ApiContext, type Review,
} from '../_lib';

interface CreateReviewBody {
  kidId: string;
  bookIsbn: string;
  rating: number;
  liked?: string | null;
  disliked?: string | null;
  notes?: string | null;
  dateRead?: string | null;
}

export const onRequestPost = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const body = await readJson<CreateReviewBody>(ctx.request);
  if (!body.kidId || !body.bookIsbn) return jsonError('kidId and bookIsbn required', 400);
  if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) {
    return jsonError('rating must be 1-5', 400);
  }
  const id = uid();
  try {
    await ctx.env.DB
      .prepare(`
        INSERT INTO reviews
          (id, kid_id, book_isbn, rating, liked, disliked, notes, date_read, created_by_email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id, body.kidId, body.bookIsbn, body.rating,
        body.liked ?? null, body.disliked ?? null, body.notes ?? null,
        body.dateRead ?? null, currentEmail(ctx.request),
      )
      .run();
  } catch (e: any) {
    if (String(e?.message ?? '').includes('FOREIGN KEY')) {
      return jsonError('kid or book does not exist', 400);
    }
    throw e;
  }
  const created: Review = {
    id, kidId: body.kidId, bookIsbn: body.bookIsbn, rating: body.rating,
    liked: body.liked ?? null, disliked: body.disliked ?? null,
    notes: body.notes ?? null, dateRead: body.dateRead ?? null,
  };
  return json(created, { status: 201 });
});
