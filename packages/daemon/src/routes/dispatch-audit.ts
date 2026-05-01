import { classifyDispatchReliability, type Services } from '@penumbra/core';

export async function dispatchAuditRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const handoffId = url.searchParams.get('handoff_id');
  if (!handoffId) return json({ error: 'missing_handoff_id' }, 400);

  const handoff = services.handoffReader.get(handoffId);
  if (!handoff) return json({ error: 'handoff_not_found' }, 404);

  const events = services.dispatchEventLog.listByHandoff(handoffId).map((event) => ({
    kind: event.kind,
    ts: event.ts,
    meta: parseMeta(event.meta_json),
  }));
  const responses = services.chainReader.getResponses(handoff.conversation_id, 'final');
  const finalResponseText = responses.at(-1)?.text ?? null;

  const report = classifyDispatchReliability({
    handoff: {
      handoff_id: handoff.handoff_id,
      status: handoff.status,
      ts: handoff.ts,
      resolved_at: handoff.resolved_at,
      cancel_requested_at: handoff.cancel_requested_at,
      chain_task_type: handoff.chain_task_type,
      use_worktree: handoff.use_worktree,
    },
    events,
    responseCount: responses.length,
    finalResponseText,
    worktreeChanged: null,
    reconciled: null,
    adapterStreaming: null,
    now: services.clock(),
  });

  return json({ report });
}

function parseMeta(metaJson: string | null): unknown {
  if (!metaJson) return null;
  try {
    return JSON.parse(metaJson);
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
