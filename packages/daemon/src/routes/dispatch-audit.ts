import { classifyDispatchReliability, type Services } from "@penumbra/core";
import { json } from "./_helpers.js";

// Pull the worktree-changed snapshot the worker captured at dispatch.end. We
// avoid live git probes here because by the time an audit runs (often
// post-merge), the worktree HEAD vs main signal is already destroyed.
function readWorktreeChangedSnapshot(
  events: Array<{ kind: string; meta: unknown }>,
): boolean | null {
  const dispatchEnd = events.filter((e) => e.kind === "dispatch.end").at(-1);
  const meta = dispatchEnd?.meta;
  if (meta && typeof meta === "object" && "worktree_changed" in meta) {
    const v = (meta as Record<string, unknown>).worktree_changed;
    if (typeof v === "boolean") return v;
  }
  return null;
}

function readDispatchEndCommitted(events: Array<{ kind: string; meta: unknown }>): boolean | null {
  const dispatchEnd = events.filter((e) => e.kind === "dispatch.end").at(-1);
  const meta = dispatchEnd?.meta;
  if (meta && typeof meta === "object" && "committed" in meta) {
    const v = (meta as Record<string, unknown>).committed;
    if (typeof v === "boolean") return v;
  }
  return null;
}

function readClassifierDecline(
  events: Array<{ kind: string; meta: unknown }>,
): { classifier_declined: true; decline_reason: string | null } | undefined {
  const dispatchEnd = events.filter((e) => e.kind === "dispatch.end").at(-1);
  const meta = dispatchEnd?.meta;
  if (!meta || typeof meta !== "object") return undefined;
  const record = meta as Record<string, unknown>;
  if (record.classifier_declined !== true) return undefined;
  return {
    classifier_declined: true,
    decline_reason: typeof record.decline_reason === "string" ? record.decline_reason : null,
  };
}

export async function dispatchAuditRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const handoffId = url.searchParams.get("handoff_id");
  if (!handoffId) return json({ error: "missing_handoff_id" }, 400);

  const handoff = services.handoffReader.get(handoffId);
  if (!handoff) return json({ error: "handoff_not_found" }, 404);

  const events = services.dispatchEventLog.listByHandoff(handoffId).map((event) => ({
    kind: event.kind,
    ts: event.ts,
    meta: parseMeta(event.meta_json),
  }));
  const responses = services.chainReader.getResponses(handoff.conversation_id, "final");
  const finalResponseText = responses.at(-1)?.text ?? null;

  const worktreeChanged = readWorktreeChangedSnapshot(events);
  const dispatchEndCommitted = readDispatchEndCommitted(events);

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
    dispatchEndCommitted,
    reconciled: null,
    adapterStreaming: null,
    now: services.clock(),
  });
  const classifierDecline = readClassifierDecline(events);
  if (classifierDecline) report.classifier_decline = classifierDecline;

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
