import { classifyDispatchReliability, type Services } from '@penumbra/core';

// Pull the worktree-changed snapshot the worker captured at dispatch.end. We
// avoid live git probes here because by the time an audit runs (often
// post-merge), the worktree HEAD vs main signal is already destroyed.
function readWorktreeSnapshot(events: Array<{ kind: string; meta: unknown }>): boolean | null {
  const dispatchEnd = events.find((e) => e.kind === 'dispatch.end');
  const meta = dispatchEnd?.meta;
  if (meta && typeof meta === 'object' && 'worktree_changed' in meta) {
    const v = (meta as Record<string, unknown>).worktree_changed;
    if (typeof v === 'boolean') return v;
  }
  return null;
}

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

  const worktreeChanged = readWorktreeSnapshot(events);

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
    worktreeChanged,
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
