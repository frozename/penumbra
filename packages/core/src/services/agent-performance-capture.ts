import type { Database } from "bun:sqlite";
import type { Uuid } from "../utils/uuid.js";
import { HandoffReader } from "../readers/handoff.js";
import { ChainReader, type AgentResponseEvent } from "../readers/chain.js";
import type { HandoffRow } from "../schemas/handoff.js";
import {
  AgentPerformanceCaptureFromReconcilerSchema,
  AgentPerformanceCaptureFromDispatchSchema,
  inferAgentTaskTypeForRole,
  mapDispatchReasonToAgentOutcome,
  mapMergeStatusToAgentOutcome,
  type AgentPerformanceCaptureFromDispatch,
  type AgentPerformanceCaptureFromReconciler,
  type AgentPerformanceRow,
  NON_MUTATING_TASK_TYPES,
} from "../schemas/agent-performance.js";
import { AgentPerformanceWriter } from "../writers/agent-performance.js";
import {
  classifyDispatchReliability,
  type DispatchReliabilityReport,
} from "./dispatch-reliability.js";

export function aggregateHandoffUsage(
  db: Database,
  handoffId: string,
): { cost_usd: number | null; tokens_used: number | null } {
  type Row = { sum_cost: number | null; sum_tokens: number | null; n_with_cost: number };
  const row = db
    .prepare<Row, [string]>(
      `
    WITH per_group AS (
      SELECT
        provider,
        model,
        MAX(cost_usd) AS group_cost,
        MAX(CAST(json_extract(payload_json, '$.used') AS INTEGER)) AS group_tokens
      FROM t0_events
      WHERE event_type = 'usage-update'
        AND json_extract(payload_json, '$.handoff_id') = ?
      GROUP BY provider, model
    )
    SELECT
      SUM(group_cost) AS sum_cost,
      SUM(group_tokens) AS sum_tokens,
      SUM(CASE WHEN group_cost IS NOT NULL THEN 1 ELSE 0 END) AS n_with_cost
    FROM per_group
  `,
    )
    .get(handoffId);
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

function lookupLatestLaneGateOutcome(db: Database, handoffId: string): string | null {
  type Row = { gate_status: string };
  const row = db
    .prepare<
      Row,
      [string]
    >(`SELECT gate_status FROM lane_ledger WHERE implementer_handoff = ? AND ts_closed IS NOT NULL ORDER BY ts_closed DESC LIMIT 1`)
    .get(handoffId);
  return row?.gate_status ?? null;
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
    outcome: mapMergeStatusToAgentOutcome(input.result.status),
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
    metadata_json: JSON.stringify(metadata),
  };
  return new AgentPerformanceWriter(opts.db).upsert(row);
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
): { silent_failure: boolean; tool_failure_count: number } {
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
  const silentFailure = useWorktree && worktreeChanged === false;
  return { silent_failure: silentFailure, tool_failure_count: toolFailureCount };
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
    >(`SELECT ts FROM dispatch_events WHERE handoff_id = ? AND kind = 'dispatch.end' ORDER BY ts ASC LIMIT 1`)
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
  parsedDispatchEndMeta: Record<string, unknown> | null,
  responses: AgentResponseEvent[],
): DispatchReliabilityReport {
  const eventRows = db
    .prepare<
      { kind: string; ts: string },
      [string]
    >(`SELECT kind, ts FROM dispatch_events WHERE handoff_id = ? ORDER BY ts ASC`)
    .all(handoffId);
  let worktreeChanged: boolean | null = null;
  let dispatchEndCommitted: boolean | null = null;
  if (parsedDispatchEndMeta) {
    if (typeof parsedDispatchEndMeta.worktree_changed === "boolean")
      worktreeChanged = parsedDispatchEndMeta.worktree_changed;
    if (typeof parsedDispatchEndMeta.committed === "boolean")
      dispatchEndCommitted = parsedDispatchEndMeta.committed;
  }
  if (typeof worktreeChangedHint === "boolean") worktreeChanged = worktreeChangedHint;
  return classifyDispatchReliability({
    handoff: {
      handoff_id: handoffId,
      status: handoff.status,
      ts: handoff.ts,
      resolved_at: handoff.resolved_at,
      cancel_requested_at: handoff.cancel_requested_at,
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
  });
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
  const signals = computeDispatchSignals(
    opts.db,
    input.handoff_id,
    useWorktree,
    input.worktree_changed,
    parsedDispatchEndMeta,
  );

  // Responses must be read before the dispatch completes.
  // Note: We assume t0_events for this dispatch have already been fully
  // ingested synchronously or that any async lag is budgeted before this
  // capture occurs. Breaking this ordering invariant causes getResponses
  // to return empty, leading to silent misclassification of outcomes
  // (e.g. valid non-mutating reviews scored as 'no_changes' failures).
  const responses =
    typeof input.final_response_text === "string"
      ? ([
          { text: input.final_response_text, ts: nowIso, agent: handoff.to_agent },
        ] as AgentResponseEvent[])
      : new ChainReader(opts.db).getResponses(handoff.conversation_id, "final");

  const reliabilityReport = classifyDispatchReliabilityFromDb(
    opts.db,
    input.handoff_id,
    handoff,
    input.worktree_changed,
    parsedDispatchEndMeta,
    responses,
  );
  const baseNotes = signals.silent_failure
    ? `${input.reason} (silent_failure: empty worktree)`
    : reliabilityReport.recommended_action === "cancel"
      ? `${input.reason} (recommended_action=cancel)`
      : input.reason;
  const recoveryCancel = detectRecoveryCancel(
    opts.db,
    input.handoff_id,
    handoff.cancel_requested_at,
  );
  const notes = recoveryCancel ? `${baseNotes} (maestro_takeover: recovery_cancel)` : baseNotes;

  const finalResponseText = input.final_response_text ?? responses.map((r) => r.text).join("\n");

  const MIN_RESPONSE_CHARS = 40;
  const has_non_empty_response =
    typeof finalResponseText === "string" &&
    finalResponseText.replace(/\s/g, "").length >= MIN_RESPONSE_CHARS;

  const explicitTaskType = input.task_type ?? handoff.chain_task_type;
  const taskType = explicitTaskType ?? inferAgentTaskTypeForRole(handoff.message, handoff.to_role);

  let baseOutcome = mapDispatchReasonToAgentOutcome(input.reason, signals);

  // The upgrade deliberately gates on explicitTaskType (input or chain
  // metadata), never the inferred fallback: handoff message text is
  // agent-influenced, so an inferred task_type must not be able to promote
  // an outcome. Cost: inferred-only non-mutating dispatches keep no_changes
  // even though the row persists the inferred taskType.
  if (
    baseOutcome === "no_changes" &&
    explicitTaskType &&
    (NON_MUTATING_TASK_TYPES as readonly string[]).includes(explicitTaskType) &&
    has_non_empty_response
  ) {
    baseOutcome = "completed_with_output";
  }

  const row: AgentPerformanceRow = {
    performance_id: opts.uuid(),
    ts: nowIso,
    handoff_id: input.handoff_id,
    conversation_id: handoff.conversation_id,
    project_id: handoff.project_id,
    agent_name: handoff.to_agent,
    task_type: taskType,
    outcome: baseOutcome,
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
    maestro_takeover_required: recoveryCancel ? "y" : handoff.cancel_requested_at ? "n" : null,
    metadata_json: JSON.stringify({ reason: input.reason, ...signals }),
  };
  return new AgentPerformanceWriter(opts.db).upsert(row);
}
