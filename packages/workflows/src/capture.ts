import type { Database } from "bun:sqlite";
import type { ExecuteOutcome } from "./exec.js";
import { randomUUID } from "node:crypto";

const QUARANTINE_THRESHOLD = 3;
const FAILURE_OUTCOMES: ExecuteOutcome[] = ["render_error", "run_error", "gated_failure"];

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
  },
): void {
  db.prepare(
    `
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id,
      user_id, machine_id, session_id, event_type, lane,
      provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
      request_id, payload_json, payload_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)
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
    JSON.stringify(args.payload),
  );
}

export function captureWorkflowOutcome(input: CaptureInput): void {
  const ts = input.now().toISOString();
  const baseEvent = {
    ts,
    project: input.project,
    sessionId: input.sessionId,
    userId: input.userId,
    machineId: input.machineId,
  };

  insertT0(input.db, {
    ...baseEvent,
    event_id: randomUUID(),
    event_type: "workflow.run",
    payload: { workflow_name: input.workflowName, started_at: ts },
  });
  insertT0(input.db, {
    ...baseEvent,
    event_id: randomUUID(),
    event_type: "workflow.recall",
    payload: {
      workflow_name: input.workflowName,
      sources: input.recallSummary.sources,
      item_count: input.recallSummary.itemCount,
      warnings: input.warnings,
    },
  });
  insertT0(input.db, {
    ...baseEvent,
    event_id: randomUUID(),
    event_type: "workflow.outcome",
    payload: {
      workflow_name: input.workflowName,
      outcome: input.outcome,
      latency_ms: input.latencyMs,
      artifacts: input.artifacts,
      error_message: input.errorMessage ?? null,
      gate_evidence: input.gateEvidence ?? null,
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
        refresh_runs: number;
        intentional_runs: number;
      }
    | undefined;

  const isFailure = FAILURE_OUTCOMES.includes(input.outcome);
  const samples = (existing?.samples ?? 0) + 1;
  const successes = (existing?.successes ?? 0) + (isFailure ? 0 : 1);
  const failures = (existing?.failures ?? 0) + (isFailure ? 1 : 0);
  const consecutive = isFailure ? (existing?.consecutive_failures ?? 0) + 1 : 0;
  const quarantined = consecutive >= QUARANTINE_THRESHOLD;
  const quarantineReason = quarantined
    ? `${consecutive} consecutive failures (last: ${input.errorMessage ?? input.outcome})`
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
      isFailure ? (input.errorMessage ?? input.outcome) : null,
      consecutive,
      quarantined ? 1 : 0,
      quarantineReason,
      refreshRuns,
      intentionalRuns,
    );
}
