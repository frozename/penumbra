import type { Database } from "bun:sqlite";

import type { HandoffRow } from "../schemas/handoff.js";
import type { Uuid } from "../utils/uuid.js";

import {
  type ClosedLaneGateStatus,
  stampAgentPerformanceGateOutcomeForHandoff,
} from "../db/lane-ledger.js";
import { type AgentResponseEvent, ChainReader } from "../readers/chain.js";
import { HandoffReader } from "../readers/handoff.js";
import {
  type AgentOutcome,
  type AgentPerformanceCaptureFromDispatch,
  AgentPerformanceCaptureFromDispatchSchema,
  type AgentPerformanceCaptureFromReconciler,
  AgentPerformanceCaptureFromReconcilerSchema,
  type AgentPerformanceRow,
  inferAgentTaskTypeForRole,
  mapDispatchReasonToAgentOutcome,
  mapMergeStatusToAgentOutcome,
  NON_MUTATING_TASK_TYPES,
} from "../schemas/agent-performance.js";
import { AgentPerformanceWriter } from "../writers/agent-performance.js";
import {
  classifyDispatchReliability,
  type DispatchReliabilityReport,
  isAgyQuotaFailure,
} from "./dispatch-reliability.js";

// #298: isAgyQuotaFailure now lives in dispatch-reliability.ts; re-exported
// so existing imports from this module keep compiling.
export { isAgyQuotaFailure };

export const MIN_RESPONSE_CHARS = 40;

// usage-update events carry per-turn delta usage, not running totals
// — taking MAX within a (provider, model) group loses every turn except
// the largest. SUM aggregates the deltas correctly across multiple
// turns of the same dispatch. The CASE/json_valid handoff_id predicate
// must match the t0_events_usage_update_handoff expression index
// verbatim; an unguarded json_extract misses the index and throws on
// malformed payloads.
export const AGGREGATE_HANDOFF_USAGE_SQL = `
    WITH per_group AS (
      SELECT
        provider,
        model,
        SUM(cost_usd) AS group_cost,
        SUM(CAST(json_extract(payload_json, '$.used') AS INTEGER)) AS group_tokens
      FROM t0_events
      WHERE event_type = 'usage-update'
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.handoff_id') END = ?
      GROUP BY provider, model
    )
    SELECT
      SUM(group_cost) AS sum_cost,
      SUM(group_tokens) AS sum_tokens,
      SUM(CASE WHEN group_cost IS NOT NULL THEN 1 ELSE 0 END) AS n_with_cost
    FROM per_group
  `;

export function meaningfulOutput(text: string | null | undefined): {
  chars: number;
  meaningful: boolean;
} {
  const chars = typeof text === "string" ? text.replaceAll(/\s/g, "").length : 0;
  return { chars, meaningful: chars >= MIN_RESPONSE_CHARS };
}

export function aggregateHandoffUsage(
  db: Database,
  handoffId: string,
): { cost_usd: number | null; tokens_used: number | null } {
  type Row = { sum_cost: number | null; sum_tokens: number | null; n_with_cost: number };
  const row = db.prepare<Row, [string]>(AGGREGATE_HANDOFF_USAGE_SQL).get(handoffId);
  return {
    cost_usd: (row?.n_with_cost ?? 0) > 0 ? (row?.sum_cost ?? null) : null,
    tokens_used: row?.sum_tokens ?? null,
  };
}

function computeLatencyMs(ts: string, resolvedAt: string | null, nowIso: string): number | null {
  const start = new Date(ts).getTime();
  if (isNaN(start)) return null;
  const end = new Date(resolvedAt ?? nowIso).getTime();
  if (isNaN(end)) return null;
  return end - start;
}

function normalizeNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function lookupLatestLaneGateOutcome(db: Database, handoffId: string): ClosedLaneGateStatus | null {
  type Row = { gate_status: ClosedLaneGateStatus };
  const row = db
    .prepare<
      Row,
      [string]
    >(`SELECT gate_status FROM lane_ledger WHERE implementer_handoff = ? AND ts_closed IS NOT NULL ORDER BY ts_closed DESC LIMIT 1`)
    .get(handoffId);
  return row?.gate_status ?? null;
}

function upsertAgentPerformanceWithGuardedGateOutcome(
  db: Database,
  row: AgentPerformanceRow,
): AgentPerformanceRow {
  const writer = new AgentPerformanceWriter(db);
  writer.upsert(row);
  if (row.gate_outcome === null) return row;
  return {
    ...row,
    gate_outcome: stampAgentPerformanceGateOutcomeForHandoff(
      db,
      row.handoff_id,
      row.gate_outcome as ClosedLaneGateStatus,
    ),
  };
}

function carryForwardOutcomeForReconcilerNoChanges(
  db: Database,
  handoffId: string,
  outcome: AgentOutcome,
): AgentOutcome {
  if (outcome !== "no_changes") return outcome;
  const existing = db
    .prepare<
      { outcome: string },
      [string]
    >(`SELECT outcome FROM agent_performance WHERE handoff_id = ?`)
    .get(handoffId);
  return existing?.outcome === "failed" || existing?.outcome === "completed_with_output"
    ? existing.outcome
    : outcome;
}

function hasMeaningfulFinalResponse(db: Database, handoff: HandoffRow, handoffId: string): boolean {
  const responses = new ChainReader(db).getResponses(handoff.conversation_id, "final", {
    handoff_id: handoffId,
  });
  return meaningfulOutput(responses.map((r) => r.text).join("\n")).meaningful;
}

function resolveReconcilerOutcome(
  db: Database,
  input: AgentPerformanceCaptureFromReconciler,
  handoff: HandoffRow,
): AgentOutcome {
  const explicitTaskType = input.task_type ?? handoff.chain_task_type ?? undefined;
  const outcome = carryForwardOutcomeForReconcilerNoChanges(
    db,
    input.handoff_id,
    mapMergeStatusToAgentOutcome(input.result.status),
  );
  if (
    outcome === "no_changes" &&
    explicitTaskType &&
    (NON_MUTATING_TASK_TYPES as readonly string[]).includes(explicitTaskType) &&
    hasMeaningfulFinalResponse(db, handoff, input.handoff_id)
  ) {
    return "completed_with_output";
  }
  return outcome;
}

// A resource kill or admission timeout is the host's fault: class it
// `resource` and mark it an environment failure so routing stays neutral.
function reconcilerFailureClassification(
  result: AgentPerformanceCaptureFromReconciler["result"],
): Pick<AgentPerformanceRow, "environment_failure" | "failure_class"> {
  const resource = result.resource_killed === true || result.resource_admission_timeout === true;
  return {
    environment_failure: resource || result.verification_environment_error === true ? "y" : null,
    ...(resource ? { failure_class: "resource" } : {}),
  };
}

export function captureAgentPerformanceFromReconciler(opts: {
  db: Database;
  uuid: Uuid;
  clock: () => Date;
  input: AgentPerformanceCaptureFromReconciler;
}): AgentPerformanceRow {
  const input = AgentPerformanceCaptureFromReconcilerSchema.parse(opts.input);
  const handoff = new HandoffReader({ db: opts.db }).get(input.handoff_id);
  if (!handoff) throw new Error(`handoff not found: ${input.handoff_id}`);
  const usage = aggregateHandoffUsage(opts.db, input.handoff_id);
  const nowIso = opts.clock().toISOString();
  const latency = computeLatencyMs(handoff.ts, handoff.resolved_at, nowIso);
  const parsedDispatchEndMeta = getParsedDispatchEndMeta(opts.db, input.handoff_id);
  const parsedAcpSessionMeta = getParsedAcpSessionMeta(opts.db, input.handoff_id);
  const metadata: Record<string, unknown> = {};
  if (input.result.pr_url) metadata.pr_url = input.result.pr_url;
  if (input.result.timed_out !== undefined) metadata.timed_out = input.result.timed_out;
  const outcome = resolveReconcilerOutcome(opts.db, input, handoff);
  const row: AgentPerformanceRow = {
    performance_id: opts.uuid(),
    ts: nowIso,
    handoff_id: input.handoff_id,
    conversation_id: handoff.conversation_id,
    project_id: handoff.project_id,
    agent_name: handoff.to_agent,
    task_type:
      input.task_type ??
      handoff.chain_task_type ??
      inferAgentTaskTypeForRole(handoff.message, handoff.to_role, input.result.status),
    outcome,
    rounds: null,
    smoke_pass: null,
    reviewer_findings: null,
    maestro_score: null,
    cost_usd: usage.cost_usd,
    tokens_used: usage.tokens_used,
    latency_ms: latency,
    exec_ms: normalizeNonnegativeInteger(input.wall_ms ?? parsedDispatchEndMeta?.wall_ms),
    framework_overhead_ms:
      normalizeNonnegativeInteger(parsedAcpSessionMeta?.framework_overhead_ms) ??
      normalizeNonnegativeInteger(input.framework_overhead_ms) ??
      normalizeNonnegativeInteger(parsedDispatchEndMeta?.framework_overhead_ms),
    source: "reconciler",
    gate_outcome: lookupLatestLaneGateOutcome(opts.db, input.handoff_id),
    notes: input.result.regression_summary ?? null,
    ...reconcilerFailureClassification(input.result),
    metadata_json: JSON.stringify(metadata),
  };
  return upsertAgentPerformanceWithGuardedGateOutcome(opts.db, row);
}

function getParsedDispatchEndMeta(db: Database, handoffId: string): Record<string, unknown> | null {
  const row = db
    .prepare<
      { meta_json: string | null },
      [string]
    >(`SELECT meta_json FROM dispatch_events WHERE handoff_id = ? AND kind = 'dispatch.end' ORDER BY ts DESC, id DESC LIMIT 1`)
    .get(handoffId);
  if (!row?.meta_json) return null;
  try {
    return JSON.parse(row.meta_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getParsedAcpSessionMeta(db: Database, handoffId: string): Record<string, unknown> | null {
  // Prefer acp.session.start (emitted unconditionally after session/new and
  // carrying the full adapter init cost) over acp.session.reuse (emitted
  // earlier on warm dispatches with only the ms-scale acquire time); fall back
  // to reuse only when no start row exists. Pick the LATEST matching event so
  // it pairs with the latest dispatch.end on swept-and-retried handoffs.
  const row = db
    .prepare<
      { meta_json: string | null },
      [string]
    >(`SELECT meta_json FROM dispatch_events WHERE handoff_id = ? AND kind IN ('acp.session.start', 'acp.session.reuse') ORDER BY (kind != 'acp.session.start') ASC, ts DESC, id DESC LIMIT 1`)
    .get(handoffId);
  if (!row?.meta_json) return null;
  try {
    return JSON.parse(row.meta_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function computeDispatchSignals(
  db: Database,
  handoffId: string,
  useWorktree: boolean,
  worktreeChangedHint: boolean | null | undefined,
  parsedDispatchEndMeta: Record<string, unknown> | null,
  explicitTaskType: string | undefined,
): {
  silent_failure: boolean;
  tool_failure_count: number;
  classifier_declined: boolean;
  decline_reason: string | null;
} {
  const countRow = db
    .prepare<
      { count: number },
      [string]
    >(`SELECT COUNT(*) as count FROM dispatch_events WHERE handoff_id = ? AND kind = 'agent.tool_call.failed'`)
    .get(handoffId);
  const toolFailureCount = countRow?.count ?? 0;

  let worktreeChanged: boolean | null = null;
  if (parsedDispatchEndMeta && typeof parsedDispatchEndMeta.worktree_changed === "boolean") {
    worktreeChanged = parsedDispatchEndMeta.worktree_changed;
  }
  // Caller-provided hint wins if present — the worker computes
  // worktree_changed at dispatch.end and passes it directly in the capture
  // payload, sidestepping the race where the dispatch.end events POST and
  // the agent_performance/dispatch POST arrive in parallel and the events
  // row hasn't committed yet when this query runs.
  if (typeof worktreeChangedHint === "boolean") worktreeChanged = worktreeChangedHint;
  // Silent failure = use_worktree=true dispatch that completed without
  // touching the worktree. The worker captures worktree_changed at
  // dispatch.end (commit 090adb1); reading it here keeps the agent-rank
  // outcome aligned with the reliability classifier's no_worktree_activity.
  const silentFailure =
    useWorktree &&
    worktreeChanged === false &&
    !(
      explicitTaskType && (NON_MUTATING_TASK_TYPES as readonly string[]).includes(explicitTaskType)
    );
  const classifierDeclined = parsedDispatchEndMeta?.classifier_declined === true;
  const declineReason =
    classifierDeclined && typeof parsedDispatchEndMeta.decline_reason === "string"
      ? parsedDispatchEndMeta.decline_reason
      : classifierDeclined
        ? "provider_safety_refusal"
        : null;
  return {
    silent_failure: silentFailure,
    tool_failure_count: toolFailureCount,
    classifier_declined: classifierDeclined,
    decline_reason: declineReason,
  };
}

function detectRecoveryCancel(
  db: Database,
  handoffId: string,
  cancelRequestedAt: string | null,
): boolean {
  if (!cancelRequestedAt) return false;
  const row = db
    .prepare<
      { ts: string },
      [string]
    >(`SELECT ts FROM dispatch_events WHERE handoff_id = ? AND kind = 'dispatch.end' ORDER BY ts DESC, id DESC LIMIT 1`)
    .get(handoffId);
  if (!row) {
    // No terminal event yet but capture is being called — likely a synthetic
    // terminal from a sweeper or a force-fail. Treat as recovery.
    return true;
  }
  return row.ts > cancelRequestedAt;
}

function classifyDispatchReliabilityFromDb(
  db: Database,
  handoffId: string,
  handoff: HandoffRow,
  worktreeChangedHint: boolean | null | undefined,
  dispatchEndEmittedHint: boolean | undefined,
  parsedDispatchEndMeta: Record<string, unknown> | null,
  responses: AgentResponseEvent[],
  nowIso: string,
): DispatchReliabilityReport {
  const eventRows = db
    .prepare<
      { kind: string; ts: string },
      [string]
    >(`SELECT kind, ts FROM dispatch_events WHERE handoff_id = ? ORDER BY ts ASC`)
    .all(handoffId);
  if (
    dispatchEndEmittedHint === true &&
    !eventRows.some((event) => event.kind === "dispatch.end")
  ) {
    // This synthetic row is local to classifier input and is never written to
    // dispatch_events. A worker crash between capture POST and finalizeDispatch's
    // emit can leave an attested row whose real event never landed; that is the
    // same trust model as worktree_changed and is visible through the handoff's
    // dispatched-exit funnel.
    eventRows.push({ kind: "dispatch.end", ts: handoff.resolved_at ?? nowIso });
  }
  let worktreeChanged: boolean | null = null;
  let dispatchEndCommitted: boolean | null = null;
  let dispatchEndDirty: boolean | null = null;
  if (parsedDispatchEndMeta) {
    if (typeof parsedDispatchEndMeta.worktree_changed === "boolean")
      worktreeChanged = parsedDispatchEndMeta.worktree_changed;
    if (typeof parsedDispatchEndMeta.committed === "boolean")
      dispatchEndCommitted = parsedDispatchEndMeta.committed;
    if (typeof parsedDispatchEndMeta.dirty === "boolean")
      dispatchEndDirty = parsedDispatchEndMeta.dirty;
  }
  if (typeof worktreeChangedHint === "boolean") worktreeChanged = worktreeChangedHint;
  return classifyDispatchReliability({
    handoff: {
      handoff_id: handoffId,
      status: handoff.status,
      ts: handoff.ts,
      resolved_at: handoff.resolved_at,
      cancel_requested_at: handoff.cancel_requested_at,
      resolution_reason: handoff.resolution_reason,
      chain_task_type: handoff.chain_task_type,
      use_worktree: handoff.use_worktree === true || (handoff.use_worktree as unknown) === 1,
    },
    events: eventRows,
    responseCount: responses.length,
    finalResponseText: responses[0]?.text ?? null,
    worktreeChanged,
    dispatchEndCommitted,
    reconciled: null,
    adapterStreaming: null,
    // No dispatchPrompt: the worker usually sends a response summary, which
    // replaces the final text with a placeholder the CHECK_RESULT rule would misread.
    dispatchEndDirty,
  });
}

interface DispatchResponseSummary {
  readonly hasMeaningfulOutput: boolean;
  readonly finalResponseChars: number;
}

interface ResolvedDispatchResponses {
  responseSummary: DispatchResponseSummary | null;
  responses: AgentResponseEvent[];
  finalResponseText: string | null;
  hasNonEmptyResponse: boolean;
}

function resolveDispatchResponses(
  db: Database,
  input: AgentPerformanceCaptureFromDispatch,
  handoff: HandoffRow,
): ResolvedDispatchResponses {
  // Responses must be read before the dispatch completes.
  // Note: We assume t0_events for this dispatch have already been fully
  // ingested synchronously or that any async lag is budgeted before this
  // capture occurs. Breaking this ordering invariant causes getResponses
  // to return empty, leading to silent misclassification of outcomes
  // (e.g. valid non-mutating reviews scored as 'no_changes' failures).
  const responseSummary: DispatchResponseSummary | null =
    typeof input.has_meaningful_output === "boolean"
      ? {
          hasMeaningfulOutput: input.has_meaningful_output,
          finalResponseChars: input.final_response_chars ?? 0,
        }
      : null;
  const responses = responseSummary
    ? []
    : new ChainReader(db).getResponses(handoff.conversation_id, "final", {
        handoff_id: input.handoff_id,
      });
  let finalResponseText: string | null;
  if (responseSummary) {
    finalResponseText = responseSummary.hasMeaningfulOutput ? "output" : null;
  } else {
    finalResponseText = responses.map((r) => r.text).join("\n");
  }
  const hasNonEmptyResponse =
    responseSummary?.hasMeaningfulOutput ?? meaningfulOutput(finalResponseText).meaningful;
  return { responseSummary, responses, finalResponseText, hasNonEmptyResponse };
}

// #295: a provider context-window overflow, read from the handoff row. The
// openai-compat-http adapter names the server's error type in its message,
// and the worker writes that message to resolution_reason. Classed only:
// whether an overflow is the seat's fault is left open, so it is not an
// environment failure and routing treats it like any other failure.
export function isContextOverflowFailure(
  handoff: Pick<HandoffRow, "resolution_reason" | "status">,
): boolean {
  return (
    handoff.status === "failed" &&
    typeof handoff.resolution_reason === "string" &&
    handoff.resolution_reason.includes("exceed_context_size_error")
  );
}

// A provider quota exit is not the seat's fault: class it `quota` and mark
// it an environment failure so routing stays neutral, like a resource kill.
// A context overflow (#295) is classed but stays charged.
function dispatchFailureClassification(
  classifierDeclined: boolean,
  quotaExhausted: boolean,
  contextOverflow: boolean,
): Pick<AgentPerformanceRow, "environment_failure" | "failure_class"> {
  if (classifierDeclined) return { failure_class: "classifier_declined" };
  if (quotaExhausted) return { environment_failure: "y", failure_class: "quota" };
  if (contextOverflow) return { failure_class: "context_overflow" };
  return { failure_class: null };
}

function buildDispatchNotes(
  reason: string,
  silentFailure: boolean,
  recommendedAction: string,
  recoveryCancel: boolean,
): string {
  let base: string;
  if (silentFailure) {
    base = `${reason} (silent_failure: empty worktree)`;
  } else if (recommendedAction === "cancel") {
    base = `${reason} (recommended_action=cancel)`;
  } else {
    base = reason;
  }
  return recoveryCancel ? `${base} (maestro_takeover: recovery_cancel)` : base;
}

function resolveDispatchOutcome(
  input: AgentPerformanceCaptureFromDispatch,
  handoff: HandoffRow,
  signals: ReturnType<typeof computeDispatchSignals>,
  hasNonEmptyResponse: boolean,
): {
  taskType: ReturnType<typeof inferAgentTaskTypeForRole>;
  outcome: AgentOutcome;
  taskTypeMismatch: boolean;
} {
  const explicitTaskType = handoff.chain_task_type ?? input.task_type;
  const taskType = explicitTaskType ?? inferAgentTaskTypeForRole(handoff.message, handoff.to_role);
  const taskTypeMismatch =
    typeof handoff.chain_task_type === "string" &&
    typeof input.task_type === "string" &&
    input.task_type !== handoff.chain_task_type;

  let outcome = mapDispatchReasonToAgentOutcome(input.reason, signals);
  // The upgrade deliberately gates on explicitTaskType (input or chain
  // metadata), never the inferred fallback: handoff message text is
  // agent-influenced, so an inferred task_type must not be able to promote
  // an outcome. Cost: inferred-only non-mutating dispatches keep no_changes
  // even though the row persists the inferred taskType.
  if (
    outcome === "no_changes" &&
    explicitTaskType &&
    (NON_MUTATING_TASK_TYPES as readonly string[]).includes(explicitTaskType) &&
    hasNonEmptyResponse
  ) {
    outcome = "completed_with_output";
  }
  return { taskType, outcome, taskTypeMismatch };
}

function buildDispatchMetadata(
  input: AgentPerformanceCaptureFromDispatch,
  handoff: HandoffRow,
  signals: ReturnType<typeof computeDispatchSignals>,
  responseSummary: DispatchResponseSummary | null,
  taskTypeMismatch: boolean,
  quotaExhausted: boolean,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    reason: input.reason,
    silent_failure: signals.silent_failure,
    tool_failure_count: signals.tool_failure_count,
  };
  if (signals.classifier_declined) {
    metadata.classifier_declined = true;
    metadata.decline_reason = signals.decline_reason;
  }
  if (taskTypeMismatch) {
    metadata.caller_task_type = input.task_type;
    metadata.handoff_task_type = handoff.chain_task_type;
    metadata.task_type_mismatch = true;
  }
  if (responseSummary) {
    metadata.final_response_chars = responseSummary.finalResponseChars;
    metadata.has_meaningful_output = responseSummary.hasMeaningfulOutput;
  }
  if (quotaExhausted) metadata.quota_exhausted = true;
  return metadata;
}

export function captureAgentPerformanceFromDispatch(opts: {
  db: Database;
  uuid: Uuid;
  clock: () => Date;
  input: AgentPerformanceCaptureFromDispatch;
}): AgentPerformanceRow {
  const input = AgentPerformanceCaptureFromDispatchSchema.parse(opts.input);
  const handoff = new HandoffReader({ db: opts.db }).get(input.handoff_id);
  if (!handoff) throw new Error(`handoff not found: ${input.handoff_id}`);
  const usage = aggregateHandoffUsage(opts.db, input.handoff_id);
  const nowIso = opts.clock().toISOString();
  const latency = computeLatencyMs(handoff.ts, handoff.resolved_at, nowIso);
  const useWorktree = handoff.use_worktree === true || (handoff.use_worktree as unknown) === 1;
  const parsedDispatchEndMeta = getParsedDispatchEndMeta(opts.db, input.handoff_id);
  const parsedAcpSessionMeta = getParsedAcpSessionMeta(opts.db, input.handoff_id);
  const execMs = normalizeNonnegativeInteger(input.wall_ms ?? parsedDispatchEndMeta?.wall_ms);
  const frameworkOverheadMs =
    normalizeNonnegativeInteger(parsedAcpSessionMeta?.framework_overhead_ms) ??
    normalizeNonnegativeInteger(input.framework_overhead_ms) ??
    normalizeNonnegativeInteger(parsedDispatchEndMeta?.framework_overhead_ms);
  const explicitTaskType = handoff.chain_task_type ?? undefined;
  const signals = computeDispatchSignals(
    opts.db,
    input.handoff_id,
    useWorktree,
    input.worktree_changed,
    parsedDispatchEndMeta,
    explicitTaskType,
  );
  const quotaExhausted = isAgyQuotaFailure(handoff);
  const contextOverflow = isContextOverflowFailure(handoff);

  const { responseSummary, responses, hasNonEmptyResponse } = resolveDispatchResponses(
    opts.db,
    input,
    handoff,
  );

  const reliabilityResponses: AgentResponseEvent[] = responseSummary?.hasMeaningfulOutput
    ? [{ text: "output", ts: nowIso, agent: handoff.to_agent, handoff_id: input.handoff_id }]
    : responses;
  const reliabilityReport = classifyDispatchReliabilityFromDb(
    opts.db,
    input.handoff_id,
    handoff,
    input.worktree_changed,
    input.dispatch_end_emitted,
    parsedDispatchEndMeta,
    reliabilityResponses,
    nowIso,
  );
  const recoveryCancel = detectRecoveryCancel(
    opts.db,
    input.handoff_id,
    handoff.cancel_requested_at,
  );
  const notes = buildDispatchNotes(
    input.reason,
    signals.silent_failure && !quotaExhausted,
    reliabilityReport.recommended_action,
    recoveryCancel,
  );

  const { taskType, outcome, taskTypeMismatch } = resolveDispatchOutcome(
    input,
    handoff,
    signals,
    hasNonEmptyResponse,
  );

  let maestroTakeover: "y" | "n" | null = null;
  if (recoveryCancel) {
    maestroTakeover = "y";
  } else if (handoff.cancel_requested_at) {
    maestroTakeover = "n";
  }

  const metadata = buildDispatchMetadata(
    input,
    handoff,
    signals,
    responseSummary,
    taskTypeMismatch,
    quotaExhausted,
  );

  const row: AgentPerformanceRow = {
    performance_id: opts.uuid(),
    ts: nowIso,
    handoff_id: input.handoff_id,
    conversation_id: handoff.conversation_id,
    project_id: handoff.project_id,
    agent_name: handoff.to_agent,
    task_type: taskType,
    outcome,
    rounds: null,
    smoke_pass: null,
    reviewer_findings: null,
    maestro_score: null,
    cost_usd: usage.cost_usd,
    tokens_used: usage.tokens_used,
    latency_ms: latency,
    exec_ms: execMs,
    framework_overhead_ms: frameworkOverheadMs,
    source: "worker",
    gate_outcome: lookupLatestLaneGateOutcome(opts.db, input.handoff_id),
    notes,
    reliability_status: reliabilityReport.status,
    ...dispatchFailureClassification(signals.classifier_declined, quotaExhausted, contextOverflow),
    maestro_takeover_required: maestroTakeover,
    metadata_json: JSON.stringify(metadata),
  };
  return upsertAgentPerformanceWithGuardedGateOutcome(opts.db, row);
}
