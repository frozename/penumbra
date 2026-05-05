import type { Database } from 'bun:sqlite';
import type { Uuid } from '../utils/uuid.js';
import { HandoffReader } from '../readers/handoff.js';
import { ChainReader } from '../readers/chain.js';
import type { HandoffRow } from '../schemas/handoff.js';
import {
  AgentPerformanceCaptureFromReconcilerSchema,
  AgentPerformanceCaptureFromDispatchSchema,
  inferAgentTaskTypeForRole,
  mapDispatchReasonToAgentOutcome,
  mapMergeStatusToAgentOutcome,
  type AgentPerformanceCaptureFromDispatch,
  type AgentPerformanceCaptureFromReconciler,
  type AgentPerformanceRow,
} from '../schemas/agent-performance.js';
import { AgentPerformanceWriter } from '../writers/agent-performance.js';
import {
  classifyDispatchReliability,
  type DispatchReliabilityReport,
} from './dispatch-reliability.js';

function aggregateHandoffUsage(db: Database, handoffId: string): { cost_usd: number | null; tokens_used: number | null } {
  type Row = { sum_cost: number | null; sum_tokens: number | null; n_with_cost: number };
  const row = db.prepare<Row, [string]>(`
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
  `).get(handoffId);
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
    task_type: input.task_type ?? inferAgentTaskTypeForRole(handoff.message, handoff.to_role, input.result.status),
    outcome: mapMergeStatusToAgentOutcome(input.result.status),
    rounds: null,
    smoke_pass: null,
    reviewer_findings: null,
    maestro_score: null,
    cost_usd: usage.cost_usd,
    tokens_used: usage.tokens_used,
    latency_ms: latency,
    source: 'reconciler',
    notes: input.result.regression_summary ?? null,
    metadata_json: JSON.stringify(metadata),
  };
  return new AgentPerformanceWriter(opts.db).upsert(row);
}

function computeDispatchSignals(
  db: Database,
  handoffId: string,
  useWorktree: boolean,
  worktreeChangedHint: boolean | null | undefined,
): { silent_failure: boolean; tool_failure_count: number } {
  type Row = { meta_json: string | null; kind: string };
  const rows = db
    .prepare<Row, [string]>(
      `SELECT kind, meta_json FROM dispatch_events WHERE handoff_id = ? AND kind IN ('dispatch.end', 'agent.tool_call.failed')`,
    )
    .all(handoffId);
  let worktreeChanged: boolean | null = null;
  let toolFailureCount = 0;
  for (const row of rows) {
    if (row.kind === 'agent.tool_call.failed') {
      toolFailureCount++;
      continue;
    }
    if (row.kind === 'dispatch.end' && row.meta_json) {
      try {
        const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
        if (typeof meta.worktree_changed === 'boolean') worktreeChanged = meta.worktree_changed;
      } catch {
        // ignore malformed meta
      }
    }
  }
  // Caller-provided hint wins if present — the worker computes
  // worktree_changed at dispatch.end and passes it directly in the capture
  // payload, sidestepping the race where the dispatch.end events POST and
  // the agent_performance/dispatch POST arrive in parallel and the events
  // row hasn't committed yet when this query runs.
  if (typeof worktreeChangedHint === 'boolean') worktreeChanged = worktreeChangedHint;
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
    .prepare<{ ts: string }, [string]>(
      `SELECT ts FROM dispatch_events WHERE handoff_id = ? AND kind = 'dispatch.end' ORDER BY ts ASC LIMIT 1`,
    )
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
): DispatchReliabilityReport {
  const eventRows = db
    .prepare<{ kind: string; ts: string; meta_json: string | null }, [string]>(
      `SELECT kind, ts, meta_json FROM dispatch_events WHERE handoff_id = ? ORDER BY ts ASC`,
    )
    .all(handoffId);
  let worktreeChanged: boolean | null = null;
  for (const row of eventRows) {
    if (row.kind === 'dispatch.end' && row.meta_json) {
      try {
        const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
        if (typeof meta.worktree_changed === 'boolean') worktreeChanged = meta.worktree_changed;
      } catch {
        // ignore malformed meta
      }
    }
  }
  if (typeof worktreeChangedHint === 'boolean') worktreeChanged = worktreeChangedHint;
  const responses = new ChainReader(db).getResponses(handoff.conversation_id, 'final');
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
    events: eventRows.map((row) => ({ kind: row.kind, ts: row.ts })),
    responseCount: responses.length,
    finalResponseText: responses[0]?.text ?? null,
    worktreeChanged,
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
  const signals = computeDispatchSignals(opts.db, input.handoff_id, useWorktree, input.worktree_changed);
  const reliabilityReport = classifyDispatchReliabilityFromDb(
    opts.db,
    input.handoff_id,
    handoff,
    input.worktree_changed,
  );
  const baseNotes = signals.silent_failure
    ? `${input.reason} (silent_failure: empty worktree)`
    : reliabilityReport.recommended_action === 'cancel'
      ? `${input.reason} (recommended_action=cancel)`
      : input.reason;
  const recoveryCancel = detectRecoveryCancel(opts.db, input.handoff_id, handoff.cancel_requested_at);
  const notes = recoveryCancel ? `${baseNotes} (maestro_takeover: recovery_cancel)` : baseNotes;
  const row: AgentPerformanceRow = {
    performance_id: opts.uuid(),
    ts: nowIso,
    handoff_id: input.handoff_id,
    conversation_id: handoff.conversation_id,
    project_id: handoff.project_id,
    agent_name: handoff.to_agent,
    task_type: input.task_type ?? inferAgentTaskTypeForRole(handoff.message, handoff.to_role),
    outcome: mapDispatchReasonToAgentOutcome(input.reason, signals),
    rounds: null,
    smoke_pass: null,
    reviewer_findings: null,
    maestro_score: null,
    cost_usd: usage.cost_usd,
    tokens_used: usage.tokens_used,
    latency_ms: latency,
    source: 'worker',
    notes,
    reliability_status: reliabilityReport.status,
    maestro_takeover_required: recoveryCancel ? 'y' : (handoff.cancel_requested_at ? 'n' : null),
    metadata_json: JSON.stringify({ reason: input.reason, ...signals }),
  };
  return new AgentPerformanceWriter(opts.db).upsert(row);
}
