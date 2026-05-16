import { z } from 'zod';
import type { Services } from '@penumbra/core';
import { json } from './_helpers.js';

const TaskDraftPendingQuerySchema = z.object({
  latest_event_type: z.enum(['task_draft', 'task_draft_escalation']),
  project_id: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

export async function taskDraftsPendingRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = TaskDraftPendingQuerySchema.safeParse({
    latest_event_type: url.searchParams.get('latest_event_type'),
    project_id: url.searchParams.get('project_id'),
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'query failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }
  const drafts = services.taskDraftReader.listPending(parsed.data);
  return json({ drafts });
}
