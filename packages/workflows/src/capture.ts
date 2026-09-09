import type { Database } from "bun:sqlite";

import { randomUUID } from "node:crypto";

import type { ExecuteOutcome } from "./exec.js";

const QUARANTINE_THRESHOLD = 3;
const FAILURE_OUTCOMES = new Set<ExecuteOutcome>(["render_error", "run_error", "gated_failure"]);

export type CaptureInput = {
  db: Database;
  workflowName: string;
  outcome: ExecuteOutcome;
  latencyMs: number;
  artifacts: string[];
  warnings: string[];
  recallSummary: { sources: string[]; itemCount: number };
  errorMessage?: string;
  gateEvidence?: Record<string, string>;
  project: string;
  sessionId: string;
  userId: string;
  machineId: string;
  now: () => Date;
  kind?: "refresh" | "intentional";
  workflowRunId?: string | null;
};

function insertT0(
  db: Database,
  args: {
    event_id: string;
    ts: string;
    project: string;
    sessionId: string;
    userId: string;
    machineId: string;
    event_type: string;
    payload: Record<string, unknown>;
    latency_ms: number;
  },
): void {
  // provider, model, tokens_in, tokens_out, cost_usd, request_id and
  // payload_summary stay NULL: a workflow row is a container and spends nothing;
  // its dispatched handoffs spend, and that spend is already summed into
  // agent_performance by aggregateHandoffUsage. workflow_run_id is the durable
  // join key and is written into payload_json, not request_id.
  db.prepare(
    `
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id,
      user_id, machine_id, session_id, event_type, lane,
      provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
      request_id, payload_json, payload_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, NULL)
  `,
  ).run(
    args.event_id,
    args.ts,
    args.ts,
    "agentchat",
    "workflows",
    args.project,
    args.userId,
    args.machineId,
    args.sessionId,
    args.event_type,
    "local",
    args.latency_ms,
    JSON.stringify(args.payload),
  );
}

export function captureWorkflowOutcome(input: CaptureInput): void {
  const now = input.now();
  const ts = now.toISOString();
  // The three lifecycle events (run, recall, outcome) are emitted in one
  // synchronous burst, so a single `now()` would stamp them with an identical
  // ts. Consumers read them back with `ORDER BY ts`, where ties have an
  // undefined order in SQLite — which surfaced as the events coming back
  // reversed. Stagger each event by 1ms in causal order so the persisted order
  // is deterministic; payload/stats semantics keep the canonical `ts`.
  const eventTs = (offsetMs: number): string => new Date(now.getTime() + offsetMs).toISOString();
  const base = {
    project: input.project,
    sessionId: input.sessionId,
    userId: input.userId,
    machineId: input.machineId,
  };

  // Atomic lifecycle: all three t0 events plus the stats read+upsert commit
  // together, or none at all. A throwing stats upsert (e.g. SQLITE_FULL inside
  // an FTS5 trigger) would otherwise leave half-written t0 rows and a
  // permanently undercounted stats row.
  const workflowRunIdPayload =
    input.workflowRunId !== undefined ? { workflow_run_id: input.workflowRunId } : {};

  input.db.transaction(() => {
    insertT0(input.db, {
      ...base,
      ts: eventTs(0),
      event_id: randomUUID(),
      event_type: "workflow.run",
      latency_ms: input.latencyMs,
      payload: { workflow_name: input.workflowName, started_at: ts, ...workflowRunIdPayload },
    });
    insertT0(input.db, {
      ...base,
      ts: eventTs(1),
      event_id: randomUUID(),
      event_type: "workflow.recall",
      latency_ms: input.latencyMs,
      payload: {
        workflow_name: input.workflowName,
        sources: input.recallSummary.sources,
        item_count: input.recallSummary.itemCount,
        warnings: input.warnings,
      },
    });
    insertT0(input.db, {
      ...base,
      ts: eventTs(2),
      event_id: randomUUID(),
      event_type: "workflow.outcome",
      latency_ms: input.latencyMs,
      payload: {
        workflow_name: input.workflowName,
        outcome: input.outcome,
        latency_ms: input.latencyMs,
        artifacts: input.artifacts,
        error_message: input.errorMessage ?? null,
        gate_evidence: input.gateEvidence ?? null,
        ...workflowRunIdPayload,
      },
    });

    const existing = input.db
      .query("SELECT * FROM workflow_stats WHERE workflow_name = ?")
      .get(input.workflowName) as
      | {
          samples: number;
          successes: number;
          failures: number;
          avg_latency_ms: number;
          consecutive_failures: number;
          last_failure_at: string | null;
          last_failure_reason: string | null;
          refresh_runs: number;
          intentional_runs: number;
        }
      | undefined;

    const isFailure = FAILURE_OUTCOMES.has(input.outcome);
    const samples = (existing?.samples ?? 0) + 1;
    const successes = (existing?.successes ?? 0) + (isFailure ? 0 : 1);
    const failures = (existing?.failures ?? 0) + (isFailure ? 1 : 0);
    const consecutive = isFailure ? (existing?.consecutive_failures ?? 0) + 1 : 0;
    const quarantined = consecutive >= QUARANTINE_THRESHOLD;
    const quarantineReason = quarantined
      ? `${String(consecutive)} consecutive failures (last: ${input.errorMessage ?? input.outcome})`
      : null;
    const prevAvg = existing?.avg_latency_ms ?? 0;
    const avgLatency = Math.round((prevAvg * (samples - 1) + input.latencyMs) / samples);

    const kind = input.kind ?? "intentional";
    const refreshRuns = (existing?.refresh_runs ?? 0) + (kind === "refresh" ? 1 : 0);
    const intentionalRuns = (existing?.intentional_runs ?? 0) + (kind === "intentional" ? 1 : 0);

    input.db
      .prepare(
        `
      INSERT INTO workflow_stats (
        workflow_name, samples, successes, failures, avg_latency_ms,
        last_run_at, last_failure_at, last_failure_reason, consecutive_failures,
        quarantined, quarantine_reason, refresh_runs, intentional_runs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_name) DO UPDATE SET
        samples = excluded.samples,
        successes = excluded.successes,
        failures = excluded.failures,
        avg_latency_ms = excluded.avg_latency_ms,
        last_run_at = excluded.last_run_at,
        last_failure_at = excluded.last_failure_at,
        last_failure_reason = excluded.last_failure_reason,
        consecutive_failures = excluded.consecutive_failures,
        quarantined = excluded.quarantined,
        quarantine_reason = excluded.quarantine_reason,
        refresh_runs = excluded.refresh_runs,
        intentional_runs = excluded.intentional_runs
    `,
      )
      .run(
        input.workflowName,
        samples,
        successes,
        failures,
        avgLatency,
        ts,
        isFailure ? ts : (existing?.last_failure_at ?? null),
        isFailure ? (input.errorMessage ?? input.outcome) : (existing?.last_failure_reason ?? null),
        consecutive,
        quarantined ? 1 : 0,
        quarantineReason,
        refreshRuns,
        intentionalRuns,
      );
  })();
}
