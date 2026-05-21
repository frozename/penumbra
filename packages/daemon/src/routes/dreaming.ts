import { z } from 'zod';
import type { Services } from '@penumbra/core';
import { listPendingDreamActionsQuery } from '../dreaming/digest.js';
import { json } from './_helpers.js';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function dreamingPendingActionsRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: 'validation_error', message: 'invalid query parameters' } }, 400);
  }
  return json(listPendingDreamActionsQuery(services.db, parsed.data));
}
