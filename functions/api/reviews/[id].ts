import { guardPreviewWrites, handler, json, jsonError, type ApiContext } from '../_lib';

export const onRequestDelete = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const id = ctx.params.id as string;
  const result = await ctx.env.DB
    .prepare('DELETE FROM reviews WHERE id = ?')
    .bind(id)
    .run();
  if (!result.meta.changes) return jsonError('review not found', 404);
  return json({ deleted: id });
});
