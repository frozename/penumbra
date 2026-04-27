import type { Services } from '@penumbra/core';
import { ConversationStreamEventSchema } from '@penumbra/core';

/**
 * POST /handoffs/:id/progress
 * Invoked by workers to push buffered progress deltas or final hop results.
 */
export async function handoffsProgressRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) {
    return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);
  }

  const parsed = ConversationStreamEventSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }

  // Late-progress rejection: Check if the handoff is still active.
  const row = services.handoffReader.get(handoff_id);
  if (!row) {
    return json({ error: { code: 'not_found', message: `handoff ${handoff_id} does not exist` } }, 404);
  }

  if (row.status === 'completed' || row.status === 'failed' || row.status === 'rejected') {
    return json({
      error: {
        code: 'gone',
        message: `handoff ${handoff_id} is in terminal status ${row.status}; progress rejected`,
      },
    }, 410);
  }

  // Broadcast to live subscribers and store in transient memory cache.
  services.conversationStream.emit(row.conversation_id, parsed.data);

  return json({ ok: true });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
