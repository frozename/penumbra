import {
  AgentTaskTypeSchema,
  type CommitIntegrityEvidence as CommitIntegrityEvidenceAlias,
  type DispatchRecommendedAction as DispatchRecommendedActionAlias,
  type DispatchReliabilityStatus as DispatchReliabilityStatusAlias,
} from "@penumbra/api-contract";

export type DispatchReliabilityStatus = DispatchReliabilityStatusAlias;

export type DispatchRecommendedAction = DispatchRecommendedActionAlias;

export type CommitIntegrityEvidence = CommitIntegrityEvidenceAlias;

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
  dispatchPrompt?: string | null;
  dispatchEndDirty?: boolean | null;
  commitIntegrity?: CommitIntegrityEvidence | null;
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
    commit_integrity?: CommitIntegrityEvidence | null;
  };
  recommended_action: DispatchRecommendedAction;
  classifier_decline?: {
    classifier_declined: true;
    decline_reason: string | null;
  };
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "rejected", "expired"]);
const ADAPTER_EVENT_PREFIXES = ["proc.", "http.", "acp."];

interface ClassificationContext {
  input: DispatchReliabilityInput;
  eventKinds: string[];
  toolFailureCount: number;
  hasAdapterLifecycle: boolean;
  terminal: boolean;
  cancelRequested: boolean;
  watchdogFailed: boolean;
  missing: string[];
  baseEvidence: DispatchReliabilityReport["evidence"];
}

function buildClassificationContext(input: DispatchReliabilityInput): ClassificationContext {
  const eventKinds = input.events.map((event) => event.kind);
  const toolFailureCount = input.events.filter(
    (event) => event.kind === "agent.tool_call.failed",
  ).length;
  const hasAdapterLifecycle = eventKinds.some((kind) =>
    ADAPTER_EVENT_PREFIXES.some((prefix) => kind.startsWith(prefix)),
  );
  const terminal = TERMINAL_STATUSES.has(input.handoff.status);
  const cancelRequested = input.handoff.cancel_requested_at !== null;
  const watchdogFailed = eventKinds.includes("watchdog.auto_fail");
  const missing: string[] = [];
  if (!eventKinds.includes("dispatch.start")) missing.push("dispatch.start");
  if (!hasAdapterLifecycle) missing.push("adapter.lifecycle");
  if (!eventKinds.includes("dispatch.end")) missing.push("dispatch.end");

  return {
    input,
    eventKinds,
    toolFailureCount,
    hasAdapterLifecycle,
    terminal,
    cancelRequested,
    watchdogFailed,
    missing,
    baseEvidence: {
      handoff_status: input.handoff.status,
      event_count: input.events.length,
      response_count: input.responseCount,
      worktree_changed: input.worktreeChanged,
      dispatch_end_committed: input.dispatchEndCommitted,
      reconciled: input.reconciled,
      watchdog_failed: watchdogFailed,
      cancel_requested: cancelRequested,
      adapter_streaming: input.adapterStreaming,
      ...(input.commitIntegrity ? { commit_integrity: input.commitIntegrity } : {}),
    },
  };
}

function makeReport(
  ctx: ClassificationContext,
  status: DispatchReliabilityStatus,
  trustworthy: boolean,
  summary: string,
  recommended_action: DispatchRecommendedAction,
  missing_events: string[] = ctx.missing,
): DispatchReliabilityReport {
  return {
    handoff_id: ctx.input.handoff.handoff_id,
    status,
    terminal: ctx.terminal,
    trustworthy,
    summary,
    missing_events,
    evidence: ctx.baseEvidence,
    recommended_action,
  };
}

function classifyStaleAndCancel(ctx: ClassificationContext): DispatchReliabilityReport | null {
  if (!ctx.terminal && isStale(ctx.input)) {
    return makeReport(
      ctx,
      "non_terminal_stale",
      false,
      "handoff is non-terminal past the stale threshold",
      usesWorktree(ctx.input.handoff) || ctx.input.adapterStreaming === false
        ? "inspect_worktree"
        : "cancel",
      [],
    );
  }
  if (ctx.cancelRequested && ctx.input.handoff.status === "completed") {
    return makeReport(
      ctx,
      "cancel_completed",
      false,
      "cancel-requested handoff completed",
      "review_manually",
      [],
    );
  }
  return null;
}

function classifyMissingLifecycle(ctx: ClassificationContext): DispatchReliabilityReport | null {
  if (ctx.watchdogFailed && !ctx.eventKinds.includes("dispatch.end")) {
    return makeReport(
      ctx,
      "watchdog_only",
      false,
      "watchdog failed the handoff without dispatch.end",
      "retry",
      ["dispatch.end"],
    );
  }
  if (!ctx.eventKinds.includes("dispatch.start")) {
    return makeReport(
      ctx,
      "missing_dispatch_start",
      false,
      "dispatch.start event is missing",
      "review_manually",
      ["dispatch.start"],
    );
  }
  if (!ctx.hasAdapterLifecycle) {
    return makeReport(
      ctx,
      "missing_adapter_lifecycle",
      false,
      "adapter lifecycle event is missing",
      "review_manually",
      ["adapter.lifecycle"],
    );
  }
  if (!ctx.eventKinds.includes("dispatch.end")) {
    return makeReport(
      ctx,
      "missing_dispatch_end",
      false,
      "dispatch.end event is missing",
      ctx.terminal ? "review_manually" : "wait",
      ["dispatch.end"],
    );
  }
  return null;
}

function classifyCommitIntegrity(ctx: ClassificationContext): DispatchReliabilityReport | null {
  const ci = ctx.input.commitIntegrity;
  if (!ctx.terminal || !ci) return null;
  if (!ci.base_is_ancestor) {
    return makeReport(
      ctx,
      "base_not_ancestor",
      false,
      `branch head ${ci.head_sha.slice(0, 12)} does not descend from dispatch base ${ci.base_sha.slice(0, 12)}`,
      "review_manually",
      [],
    );
  }
  if (ci.mismatched_commits.length > 0) {
    return makeReport(
      ctx,
      "commit_identity_mismatch",
      false,
      `commits not authored and committed as ${ci.identity.name} <${ci.identity.email}>: ${ci.mismatched_commits.map((sha) => sha.slice(0, 12)).join(", ")}`,
      "review_manually",
      [],
    );
  }
  return null;
}

function classifyResultIntegrity(ctx: ClassificationContext): DispatchReliabilityReport | null {
  if (ctx.terminal && ctx.input.responseCount === 0 && !ctx.input.finalResponseText?.trim()) {
    return makeReport(
      ctx,
      "no_agent_output",
      false,
      "terminal handoff has no agent output",
      "retry",
      [],
    );
  }
  if (
    isImplementationTask(ctx.input.handoff) &&
    ctx.terminal &&
    ctx.input.worktreeChanged === false
  ) {
    return makeReport(
      ctx,
      "no_worktree_activity",
      false,
      "implementation task completed without worktree activity",
      "review_manually",
      [],
    );
  }
  // tool_call.failed events are treated as recovered when dispatch.end reported committed=true.
  if (
    ctx.terminal &&
    ctx.toolFailureCount > 0 &&
    ctx.input.worktreeChanged === true &&
    ctx.input.dispatchEndCommitted !== true
  ) {
    return makeReport(
      ctx,
      "tool_failure_with_end_turn",
      false,
      `tool call failed during dispatch (${String(ctx.toolFailureCount)}); end_turn reached without recovery`,
      "retry",
      [],
    );
  }
  if (
    isImplementationTask(ctx.input.handoff) &&
    ctx.terminal &&
    ctx.input.worktreeChanged === true &&
    ctx.input.reconciled === false
  ) {
    return makeReport(
      ctx,
      "reconcile_missing",
      false,
      "implementation task changed files but lacks reconciliation evidence",
      "review_manually",
      [],
    );
  }
  if (hasImpossibleOrder(ctx.input.events)) {
    return makeReport(
      ctx,
      "timeline_inconsistent",
      false,
      "dispatch timeline has impossible event ordering",
      "review_manually",
      [],
    );
  }
  return null;
}

// Keyed on the exact closing instruction of the fix-until-green round prompt
// (plugin/workflows/penumbra-fix-until-green/check-parse.ts roundMessage); the
// response pattern mirrors that workflow's own verdict parser.
const CHECK_RESULT_PRESCRIPTION =
  /^IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`/m;
const CHECK_RESULT_LINE = /^ {0,3}CHECK_RESULT:[ \t]*(?:PASS|FAIL)\b/im;

function lacksPrescribedReturnBlock(input: DispatchReliabilityInput): boolean {
  if (!input.dispatchPrompt || !CHECK_RESULT_PRESCRIPTION.test(input.dispatchPrompt)) return false;
  return !CHECK_RESULT_LINE.test(input.finalResponseText ?? "");
}

function classifyIncompleteTurn(ctx: ClassificationContext): DispatchReliabilityReport | null {
  if (ctx.input.handoff.status !== "completed") return null;
  if (lacksPrescribedReturnBlock(ctx.input)) {
    return makeReport(
      ctx,
      "end_turn_without_return_block",
      false,
      "final response lacks the CHECK_RESULT line the dispatch prompt prescribes",
      "retry",
      [],
    );
  }
  if (ctx.input.dispatchEndDirty === true && isImplementationTask(ctx.input.handoff)) {
    return makeReport(
      ctx,
      "end_turn_without_return_block",
      false,
      "implementation task ended its turn with uncommitted changes in the worktree",
      "retry",
      [],
    );
  }
  return null;
}

export function classifyDispatchReliability(
  input: DispatchReliabilityInput,
): DispatchReliabilityReport {
  const ctx = buildClassificationContext(input);
  const earlyReport =
    classifyStaleAndCancel(ctx) ??
    classifyMissingLifecycle(ctx) ??
    classifyCommitIntegrity(ctx) ??
    classifyResultIntegrity(ctx) ??
    classifyIncompleteTurn(ctx);
  if (earlyReport) return earlyReport;
  if (!ctx.terminal) {
    return makeReport(ctx, "complete", false, "handoff is still running and not stale", "wait", []);
  }
  return makeReport(
    ctx,
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

const IMPLEMENTING_TASK_TYPES = new Set<string>(["implement_small", "implement_substantial"]);
const KNOWN_TASK_TYPES = new Set<string>(AgentTaskTypeSchema.options);

function isImplementationTask(handoff: DispatchReliabilityHandoff): boolean {
  const taskType = handoff.chain_task_type ?? "";
  if (IMPLEMENTING_TASK_TYPES.has(taskType)) return true;
  if (KNOWN_TASK_TYPES.has(taskType) && taskType !== "unknown") return false;
  return usesWorktree(handoff);
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
