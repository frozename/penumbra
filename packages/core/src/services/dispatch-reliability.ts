export type DispatchReliabilityStatus =
  | "complete"
  | "missing_dispatch_start"
  | "missing_adapter_lifecycle"
  | "missing_dispatch_end"
  | "non_terminal_stale"
  | "cancel_completed"
  | "watchdog_only"
  | "no_agent_output"
  | "no_worktree_activity"
  | "tool_failure_with_end_turn"
  | "reconcile_missing"
  | "agent_declared_done_unverified"
  | "timeline_inconsistent";

export type DispatchRecommendedAction =
  | "wait"
  | "inspect_worktree"
  | "cancel"
  | "retry"
  | "review_manually"
  | "accept";

export interface DispatchReliabilityEvent {
  kind: string;
  ts: string;
  meta?: unknown;
}

export interface DispatchReliabilityHandoff {
  handoff_id: string;
  status: string;
  ts: string;
  resolved_at: string | null;
  cancel_requested_at: string | null;
  chain_task_type?: string | null;
  use_worktree?: boolean | number | null;
}

export interface DispatchReliabilityInput {
  handoff: DispatchReliabilityHandoff;
  events: DispatchReliabilityEvent[];
  responseCount: number;
  finalResponseText: string | null;
  worktreeChanged: boolean | null;
  dispatchEndCommitted: boolean | null;
  reconciled: boolean | null;
  adapterStreaming: boolean | null;
  now?: Date;
  staleAfterMs?: number;
  activityIdleMs?: number;
}

export interface DispatchReliabilityReport {
  handoff_id: string;
  status: DispatchReliabilityStatus;
  terminal: boolean;
  trustworthy: boolean;
  summary: string;
  missing_events: string[];
  evidence: {
    handoff_status: string;
    event_count: number;
    response_count: number;
    worktree_changed: boolean | null;
    dispatch_end_committed: boolean | null;
    reconciled: boolean | null;
    watchdog_failed: boolean;
    cancel_requested: boolean;
    adapter_streaming: boolean | null;
  };
  recommended_action: DispatchRecommendedAction;
  classifier_decline?: {
    classifier_declined: true;
    decline_reason: string | null;
  };
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "rejected", "expired"]);
const ADAPTER_EVENT_PREFIXES = ["proc.", "http.", "acp."];

export function classifyDispatchReliability(
  input: DispatchReliabilityInput,
): DispatchReliabilityReport {
  const eventKinds = input.events.map((event) => event.kind);
  const has = (kind: string) => eventKinds.includes(kind);
  const toolFailureCount = input.events.filter(
    (event) => event.kind === "agent.tool_call.failed",
  ).length;
  const hasAdapterLifecycle = eventKinds.some((kind) =>
    ADAPTER_EVENT_PREFIXES.some((prefix) => kind.startsWith(prefix)),
  );
  const terminal = TERMINAL_STATUSES.has(input.handoff.status);
  const cancelRequested = input.handoff.cancel_requested_at !== null;
  const watchdogFailed = has("watchdog.auto_fail");
  const missing: string[] = [];

  if (!has("dispatch.start")) missing.push("dispatch.start");
  if (!hasAdapterLifecycle) missing.push("adapter.lifecycle");
  if (!has("dispatch.end")) missing.push("dispatch.end");

  const baseEvidence = {
    handoff_status: input.handoff.status,
    event_count: input.events.length,
    response_count: input.responseCount,
    worktree_changed: input.worktreeChanged,
    dispatch_end_committed: input.dispatchEndCommitted,
    reconciled: input.reconciled,
    watchdog_failed: watchdogFailed,
    cancel_requested: cancelRequested,
    adapter_streaming: input.adapterStreaming,
  };

  const report = (
    status: DispatchReliabilityStatus,
    trustworthy: boolean,
    summary: string,
    recommended_action: DispatchRecommendedAction,
    missing_events = missing,
  ): DispatchReliabilityReport => ({
    handoff_id: input.handoff.handoff_id,
    status,
    terminal,
    trustworthy,
    summary,
    missing_events,
    evidence: baseEvidence,
    recommended_action,
  });

  if (!terminal && isStale(input)) {
    return report(
      "non_terminal_stale",
      false,
      "handoff is non-terminal past the stale threshold",
      usesWorktree(input.handoff) || input.adapterStreaming === false
        ? "inspect_worktree"
        : "cancel",
      [],
    );
  }

  if (cancelRequested && input.handoff.status === "completed") {
    return report(
      "cancel_completed",
      false,
      "cancel-requested handoff completed",
      "review_manually",
      [],
    );
  }

  if (watchdogFailed && !has("dispatch.end")) {
    return report(
      "watchdog_only",
      false,
      "watchdog failed the handoff without dispatch.end",
      "retry",
      ["dispatch.end"],
    );
  }

  if (!has("dispatch.start")) {
    return report(
      "missing_dispatch_start",
      false,
      "dispatch.start event is missing",
      "review_manually",
      ["dispatch.start"],
    );
  }

  if (!hasAdapterLifecycle) {
    return report(
      "missing_adapter_lifecycle",
      false,
      "adapter lifecycle event is missing",
      "review_manually",
      ["adapter.lifecycle"],
    );
  }

  if (!has("dispatch.end")) {
    return report(
      "missing_dispatch_end",
      false,
      "dispatch.end event is missing",
      terminal ? "review_manually" : "wait",
      ["dispatch.end"],
    );
  }

  if (terminal && input.responseCount === 0 && !input.finalResponseText?.trim()) {
    return report("no_agent_output", false, "terminal handoff has no agent output", "retry", []);
  }

  if (isImplementationTask(input.handoff) && terminal && input.worktreeChanged === false) {
    return report(
      "no_worktree_activity",
      false,
      "implementation task completed without worktree activity",
      "review_manually",
      [],
    );
  }

  // tool_call.failed events are treated as recovered when dispatch.end reported committed=true.
  if (
    terminal &&
    toolFailureCount > 0 &&
    input.worktreeChanged === true &&
    input.dispatchEndCommitted !== true
  ) {
    return report(
      "tool_failure_with_end_turn",
      false,
      `tool call failed during dispatch (${toolFailureCount}); end_turn reached without recovery`,
      "retry",
      [],
    );
  }

  if (
    isImplementationTask(input.handoff) &&
    terminal &&
    input.worktreeChanged === true &&
    input.reconciled === false
  ) {
    return report(
      "reconcile_missing",
      false,
      "implementation task changed files but lacks reconciliation evidence",
      "review_manually",
      [],
    );
  }

  if (hasImpossibleOrder(input.events)) {
    return report(
      "timeline_inconsistent",
      false,
      "dispatch timeline has impossible event ordering",
      "review_manually",
      [],
    );
  }

  if (!terminal) {
    return report("complete", false, "handoff is still running and not stale", "wait", []);
  }

  return report(
    "complete",
    true,
    "dispatch lifecycle and result evidence are complete",
    "accept",
    [],
  );
}

function isStale(input: DispatchReliabilityInput): boolean {
  const staleAfterMs = input.staleAfterMs ?? 120_000;
  const activityIdleMs = input.activityIdleMs ?? 300_000;
  const nowMs = (input.now ?? new Date()).getTime();
  const handoffStartMs = new Date(input.handoff.ts).getTime();
  if (nowMs - handoffStartMs <= staleAfterMs) return false;
  const lastEventTs = input.events.reduce<string | null>(
    (acc, e) => (acc === null || e.ts > acc ? e.ts : acc),
    null,
  );
  const lastActivityMs = lastEventTs ? new Date(lastEventTs).getTime() : handoffStartMs;
  return nowMs - lastActivityMs > activityIdleMs;
}

function isImplementationTask(handoff: DispatchReliabilityHandoff): boolean {
  const taskType = handoff.chain_task_type ?? "";
  return (
    taskType === "implement_small" || taskType === "implement_substantial" || usesWorktree(handoff)
  );
}

function usesWorktree(handoff: DispatchReliabilityHandoff): boolean {
  return handoff.use_worktree === true || handoff.use_worktree === 1;
}

function hasImpossibleOrder(events: DispatchReliabilityEvent[]): boolean {
  const start = firstIndex(events, "dispatch.start");
  const end = firstIndex(events, "dispatch.end");
  return start >= 0 && end >= 0 && end < start;
}

function firstIndex(events: DispatchReliabilityEvent[], kind: string): number {
  return events.findIndex((event) => event.kind === kind);
}
