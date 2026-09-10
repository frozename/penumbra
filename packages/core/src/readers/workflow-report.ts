import type { Database } from "bun:sqlite";

import { EXECUTE_OUTCOMES, FAILURE_OUTCOMES } from "../workflows/outcomes.js";

const DEFAULT_WINDOW_HOURS = 168;
const MAX_WINDOW_HOURS = 2160;
const UNNAMED_WORKFLOW = "(unnamed)";

export interface WorkflowReportInput {
  window_hours?: number;
  project_id?: string | null;
  now?: Date;
}

export interface WorkflowReportWindow {
  from: string;
  to: string;
  hours: number;
}

export interface WorkflowReportRow {
  workflow_name: string;
  runs: number;
  ok: number;
  failed: number;
  unknown_outcome: number;
  runs_without_run_id: number;
  avg_latency_ms: number | null;
  dispatches: number;
  cost_usd: number | null;
  tokens: number | null;
  dispatches_missing_cost: number;
  framework_overhead_ms: number | null;
  reliability_complete_pct: number | null;
}

export interface WorkflowReportOutput {
  window: WorkflowReportWindow;
  rows: WorkflowReportRow[];
}

type WorkflowReportSqlRow = WorkflowReportRow;

function validateWindowHours(value: number | undefined): number {
  const hours = value ?? DEFAULT_WINDOW_HOURS;
  if (
    !Number.isFinite(hours) ||
    !Number.isInteger(hours) ||
    hours < 1 ||
    hours > MAX_WINDOW_HOURS
  ) {
    throw new Error("window_hours must be an integer from 1 to 2160");
  }
  return hours;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function normalizeRow(row: WorkflowReportSqlRow): WorkflowReportRow {
  return {
    workflow_name: row.workflow_name,
    runs: row.runs,
    ok: row.ok,
    failed: row.failed,
    unknown_outcome: row.unknown_outcome,
    runs_without_run_id: row.runs_without_run_id,
    avg_latency_ms: row.avg_latency_ms,
    dispatches: row.dispatches,
    cost_usd: row.cost_usd,
    tokens: row.tokens,
    dispatches_missing_cost: row.dispatches_missing_cost,
    framework_overhead_ms: row.framework_overhead_ms,
    reliability_complete_pct: row.reliability_complete_pct,
  };
}

export function workflowReport(
  db: Database,
  input: WorkflowReportInput = {},
): WorkflowReportOutput {
  const hours = validateWindowHours(input.window_hours);
  if (input.project_id?.length === 0) {
    throw new Error("project_id must be nonempty when provided");
  }
  const to = input.now ?? new Date();
  const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
  const okOutcomes = EXECUTE_OUTCOMES.filter((outcome) => !FAILURE_OUTCOMES.has(outcome));
  const failureOutcomes = [...FAILURE_OUTCOMES];
  const executeOutcomes = [...EXECUTE_OUTCOMES];
  const params: (string | number | null)[] = [
    UNNAMED_WORKFLOW,
    from.toISOString(),
    to.toISOString(),
    input.project_id ?? null,
    input.project_id ?? null,
    ...okOutcomes,
    ...failureOutcomes,
    ...executeOutcomes,
  ];
  const rows = db
    .query<WorkflowReportSqlRow, (string | number | null)[]>(
      `WITH outcome_events AS (
         SELECT
           COALESCE(
             NULLIF(CAST(json_extract(payload_json, '$.workflow_name') AS TEXT), ''),
             ?
           ) AS workflow_name,
           CAST(json_extract(payload_json, '$.workflow_run_id') AS TEXT) AS workflow_run_id,
           CAST(json_extract(payload_json, '$.outcome') AS TEXT) AS outcome,
           CASE
             WHEN typeof(json_extract(payload_json, '$.latency_ms')) IN ('integer', 'real')
             THEN json_extract(payload_json, '$.latency_ms')
             ELSE NULL
           END AS latency_ms
         FROM t0_events
         WHERE event_type = 'workflow.outcome'
           AND ts >= ?
           AND ts <= ?
           AND (? IS NULL OR project_id = ?)
       ),
       run_agg AS (
         SELECT
           workflow_name,
           COUNT(*) AS runs,
           SUM(CASE WHEN outcome IN (${placeholders(okOutcomes)}) THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN outcome IN (${placeholders(failureOutcomes)}) THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN outcome IS NULL OR outcome NOT IN (${placeholders(executeOutcomes)}) THEN 1 ELSE 0 END) AS unknown_outcome,
           SUM(CASE WHEN workflow_run_id IS NULL OR workflow_run_id = '' THEN 1 ELSE 0 END) AS runs_without_run_id,
           CAST(ROUND(AVG(latency_ms)) AS INTEGER) AS avg_latency_ms
         FROM outcome_events
         GROUP BY workflow_name
       ),
       distinct_runs AS (
         SELECT DISTINCT workflow_name, workflow_run_id
         FROM outcome_events
         WHERE workflow_run_id IS NOT NULL AND workflow_run_id <> ''
       ),
       dispatch_agg AS (
         SELECT
           dr.workflow_name AS workflow_name,
           COUNT(h.handoff_id) AS dispatches,
           SUM(ap.cost_usd) AS cost_usd,
           SUM(ap.tokens_used) AS tokens,
           SUM(CASE WHEN ap.handoff_id IS NOT NULL AND ap.cost_usd IS NULL THEN 1 ELSE 0 END) AS dispatches_missing_cost,
           SUM(ap.framework_overhead_ms) AS framework_overhead_ms,
           SUM(CASE WHEN ap.reliability_status = 'complete' THEN 1 ELSE 0 END) AS reliability_complete,
           SUM(CASE WHEN ap.reliability_status IS NOT NULL THEN 1 ELSE 0 END) AS reliability_samples
         FROM distinct_runs dr
         LEFT JOIN handoffs h
           ON h.workflow_run_id = dr.workflow_run_id
          AND h.dispatch_kind = 'workflow'
         LEFT JOIN agent_performance ap
           ON ap.handoff_id = h.handoff_id
         GROUP BY dr.workflow_name
       )
       SELECT
         r.workflow_name AS workflow_name,
         r.runs AS runs,
         r.ok AS ok,
         r.failed AS failed,
         r.unknown_outcome AS unknown_outcome,
         r.runs_without_run_id AS runs_without_run_id,
         r.avg_latency_ms AS avg_latency_ms,
         COALESCE(d.dispatches, 0) AS dispatches,
         d.cost_usd AS cost_usd,
         d.tokens AS tokens,
         COALESCE(d.dispatches_missing_cost, 0) AS dispatches_missing_cost,
         d.framework_overhead_ms AS framework_overhead_ms,
         CASE
           WHEN d.reliability_samples > 0
           THEN ROUND(CAST(d.reliability_complete AS REAL) / d.reliability_samples, 3)
           ELSE NULL
         END AS reliability_complete_pct
       FROM run_agg r
       LEFT JOIN dispatch_agg d ON d.workflow_name = r.workflow_name
       ORDER BY r.runs DESC, r.workflow_name ASC`,
    )
    .all(...params)
    .map(normalizeRow);
  return {
    window: { from: from.toISOString(), to: to.toISOString(), hours },
    rows,
  };
}
