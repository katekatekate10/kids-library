import {
  currentEmail, guardPreviewWrites, handler, json, kidFromRow,
  readJson, uid, type ApiContext, type Kid,
} from '../_lib';

interface CreateKidBody {
  name: string;
  age?: number | null;
  interests?: string | null;
  notes?: string | null;
}

export const onRequestPost = handler(async (ctx: ApiContext) => {
  guardPreviewWrites(ctx);
  const body = await readJson<CreateKidBody>(ctx.request);
  if (!body.name || typeof body.name !== 'string') {
    return json({ error: 'name required' }, { status: 400 });
  }
  const id = uid();
  await ctx.env.DB
    .prepare(`
      INSERT INTO kids (id, name, age, interests, notes, created_by_email)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(id, body.name, body.age ?? null, body.interests ?? null, body.notes ?? null, currentEmail(ctx.request))
    .run();
  const created: Kid = {
    id, name: body.name,
    age: body.age ?? null,
    interests: body.interests ?? null,
    notes: body.notes ?? null,
  };
  return json(created, { status: 201 });
});
