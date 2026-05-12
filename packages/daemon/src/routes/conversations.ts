import type { Services } from '@penumbra/core';
import { json } from './_helpers.js';

/**
 * POST /conversations/:id/cancel
 * Request cancellation of a conversation.
 *
 * The durable write is a single SQL UPDATE that stamps `cancel_requested_at`
 * on every matching handoff row that has not already been marked. Completion
 * is a separate atomic UPDATE on `status='dispatched'`, so cancel and complete
 * can interleave without a transaction. That race is intentional: the worker
 * control listener replays any row with a cancel marker and filters out
 * terminal rows, so a late cancel remains visible for forensics even if the
 * handoff has already completed.
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
  // We try to find a specific dispatched handoff to include in the cancel event
  const active = services.handoffReader.listByStatus({
    statuses: ['dispatched'],
    conversation_id,
  });

  if (active.length > 0) {
    for (const handoff of active) {
      services.workerControl.emit({
        type: 'cancel',
        conversation_id,
        handoff_id: handoff.handoff_id,
      });
    }
  } else {
    // Fallback: if none dispatched, we might still have a pending/approved one
    // that should be cancelled if/when it gets claimed, but for the live event
    // we can't provide a handoff_id if we don't know which one will be picked.
    // However, the schema REQUIRES handoff_id.
    // If no dispatched, we can pick the most recent approved/pending if we want to be proactive.
    const eligible = services.handoffReader.listByStatus({
      statuses: ['approved', 'redirected', 'pending'],
      conversation_id,
    });
    if (eligible.length > 0) {
      services.workerControl.emit({
        type: 'cancel',
        conversation_id,
        handoff_id: eligible[eligible.length - 1]!.handoff_id,
      });
    }
  }

  return json({ ok: true, changed });
}

