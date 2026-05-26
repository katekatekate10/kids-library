import {
  guardPreviewWrites, handler, json, jsonError, kidFromRow,
  readJson, type ApiContext, type Kid,
} from '../_lib';

interface UpdateKidBody {
  name?: string;
  age?: number | null;
  interests?: string | null;
  notes?: string | null;
}

async function loadKid(db: D1Database, id: string): Promise<Kid | null> {
  const row = await db
    .prepare('SELECT id, name, age, interests, notes FROM kids WHERE id = ?')
    .bind(id)
    .first();
  return row ? kidFromRow(row as any) : null;
}

/** Partial update — only the fields present in the body are touched. */
export const onRequestPatch = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const id = ctx.params.id as string;
  const body = await readJson<UpdateKidBody>(ctx.request);

  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, col] of [
    ['name', 'name'], ['age', 'age'], ['interests', 'interests'], ['notes', 'notes'],
  ] as const) {
    if (k in body) { sets.push(`${col} = ?`); args.push((body as any)[k]); }
  }
  if (!sets.length) return jsonError('no fields to update', 400);
  args.push(id);

  const result = await ctx.env.DB
    .prepare(`UPDATE kids SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...args)
    .run();
  if (!result.meta.changes) return jsonError('kid not found', 404);

  const updated = await loadKid(ctx.env.DB, id);
  return json(updated);
});

/** Cascade is set up at schema level — book_reads + reviews go away with the kid. */
export const onRequestDelete = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const id = ctx.params.id as string;
  const result = await ctx.env.DB
    .prepare('DELETE FROM kids WHERE id = ?')
    .bind(id)
    .run();
  if (!result.meta.changes) return jsonError('kid not found', 404);
  return json({ deleted: id });
});
