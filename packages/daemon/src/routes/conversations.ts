import type { Services } from '@penumbra/core';

/**
 * POST /conversations/:id/cancel
 * Request cancellation of a conversation.
 * Marks the conversation as cancel-requested in the DB and broadcasts to workers.
 */
export async function conversationsCancelRoute(
  _req: Request,
  conversation_id: string,
  services: Services,
): Promise<Response> {
  const ts = services.clock().toISOString();

  // 1. Record in DB
  const changed = services.handoffWriter.requestCancellation(conversation_id, ts);

  // 2. Broadcast to live workers
  services.workerControl.emit({ type: 'cancel', conversation_id });

  return json({ ok: true, changed });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
