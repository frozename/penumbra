import { loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { captureWorkflowOutcome } from "../src/capture.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

type WorkflowStatsRow = {
  samples: number;
  successes: number;
  failures: number;
  consecutive_failures: number;
  quarantined: number;
  quarantine_reason: string | null;
  refresh_runs: number;
  intentional_runs: number;
  last_failure_at: string | null;
  last_failure_reason: string | null;
};

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test("writes t0 events for run + recall + outcome", () => {
  const db = freshDb();
  captureWorkflowOutcome({
    db,
    workflowName: "demo",
    outcome: "success",
    latencyMs: 100,
    artifacts: ["/tmp/x.md"],
    warnings: [],
    recallSummary: { sources: ["memory.search"], itemCount: 4 },
    project: "test",
    sessionId: "s1",
    userId: "u",
    machineId: "m",
    now: (): Date => new Date("2026-05-04T15:00:00Z"),
  });
  const rows = db
    .query("SELECT event_type FROM t0_events WHERE event_type LIKE 'workflow.%' ORDER BY ts")
    .all() as { event_type: string }[];
  expect(rows.map((r) => r.event_type)).toEqual([
    "workflow.run",
    "workflow.recall",
    "workflow.outcome",
  ]);
});

test("upserts workflow_stats incrementing samples + successes", () => {
  const db = freshDb();
  for (let i = 0; i < 3; i++) {
    captureWorkflowOutcome({
      db,
      workflowName: "demo",
      outcome: "success",
      latencyMs: 100,
      artifacts: [],
      warnings: [],
      recallSummary: { sources: [], itemCount: 0 },
      project: "t",
      sessionId: "s",
      userId: "u",
      machineId: "m",
      now: (): Date => new Date(),
    });
  }
  const row = db
    .query(
      "SELECT samples, successes, failures, consecutive_failures, quarantined FROM workflow_stats WHERE workflow_name='demo'",
    )
    .get() as WorkflowStatsRow;
  expect(row.samples).toBe(3);
  expect(row.successes).toBe(3);
  expect(row.failures).toBe(0);
  expect(row.quarantined).toBe(0);
});

test("quarantines after 3 consecutive failures", () => {
  const db = freshDb();
  for (let i = 0; i < 3; i++) {
    captureWorkflowOutcome({
      db,
      workflowName: "flaky",
      outcome: "run_error",
      latencyMs: 50,
      artifacts: [],
      warnings: [],
      recallSummary: { sources: [], itemCount: 0 },
      errorMessage: `boom ${String(i)}`,
      project: "t",
      sessionId: "s",
      userId: "u",
      machineId: "m",
      now: (): Date => new Date(),
    });
  }
  const row = db
    .query(
      "SELECT consecutive_failures, quarantined, quarantine_reason FROM workflow_stats WHERE workflow_name='flaky'",
    )
    .get() as WorkflowStatsRow;
  expect(row.consecutive_failures).toBe(3);
  expect(row.quarantined).toBe(1);
  expect(row.quarantine_reason).toContain("3 consecutive");
});

test("refresh kind increments refresh_runs only", () => {
  const db = freshDb();
  const base = {
    db,
    workflowName: "wf",
    latencyMs: 10,
    artifacts: [],
    warnings: [],
    recallSummary: { sources: [], itemCount: 0 },
    project: "t",
    sessionId: "s",
    userId: "u",
    machineId: "m",
    now: (): Date => new Date(),
  };
  captureWorkflowOutcome({ ...base, outcome: "success", kind: "refresh" });
  captureWorkflowOutcome({ ...base, outcome: "success", kind: "intentional" });
  const row = db
    .query("SELECT * FROM workflow_stats WHERE workflow_name = ?")
    .get("wf") as WorkflowStatsRow;
  expect(row.refresh_runs).toBe(1);
  expect(row.intentional_runs).toBe(1);
  expect(row.samples).toBe(2);
});

test("default kind is intentional", () => {
  const db = freshDb();
  captureWorkflowOutcome({
    db,
    workflowName: "wf",
    outcome: "success",
    latencyMs: 10,
    artifacts: [],
    warnings: [],
    recallSummary: { sources: [], itemCount: 0 },
    project: "t",
    sessionId: "s",
    userId: "u",
    machineId: "m",
    now: (): Date => new Date(),
  });
  const row = db
    .query("SELECT * FROM workflow_stats WHERE workflow_name = ?")
    .get("wf") as WorkflowStatsRow;
  expect(row.refresh_runs).toBe(0);
  expect(row.intentional_runs).toBe(1);
});

test("preserves last_failure_at and last_failure_reason on success after failure", () => {
  const db = freshDb();
  const args = {
    db,
    workflowName: "sticky",
    latencyMs: 10,
    artifacts: [],
    warnings: [],
    recallSummary: { sources: [], itemCount: 0 },
    project: "t",
    sessionId: "s",
    userId: "u",
    machineId: "m",
    now: (): Date => new Date(),
  };
  captureWorkflowOutcome({ ...args, outcome: "run_error", errorMessage: "kaboom" });
  const afterFailure = db
    .query(
      "SELECT last_failure_at, last_failure_reason FROM workflow_stats WHERE workflow_name='sticky'",
    )
    .get() as WorkflowStatsRow;
  expect(afterFailure.last_failure_at).not.toBeNull();
  expect(afterFailure.last_failure_reason).toBe("kaboom");

  captureWorkflowOutcome({ ...args, outcome: "success" });
  const afterSuccess = db
    .query(
      "SELECT last_failure_at, last_failure_reason FROM workflow_stats WHERE workflow_name='sticky'",
    )
    .get() as WorkflowStatsRow;
  expect(afterSuccess.last_failure_at).toBe(afterFailure.last_failure_at);
  expect(afterSuccess.last_failure_reason).toBe("kaboom");
});

test("rolls back t0 events when workflow_stats upsert throws", () => {
  const db = freshDb();
  // Drop the stats table so the final upsert throws inside the transaction;
  // verifies the three t0 inserts roll back atomically with the failed write.
  db.run("DROP TABLE workflow_stats");

  expect(() => {
    captureWorkflowOutcome({
      db,
      workflowName: "atomic",
      outcome: "success",
      latencyMs: 10,
      artifacts: [],
      warnings: [],
      recallSummary: { sources: [], itemCount: 0 },
      project: "t",
      sessionId: "s",
      userId: "u",
      machineId: "m",
      now: (): Date => new Date(),
    });
  }).toThrow();

  const rows = db
    .query("SELECT COUNT(*) AS c FROM t0_events WHERE event_type LIKE 'workflow.%'")
    .get() as { c: number };
  expect(rows.c).toBe(0);
});

test("resets consecutive_failures on success after failures", () => {
  const db = freshDb();
  const args = {
    db,
    workflowName: "recovers",
    latencyMs: 10,
    artifacts: [],
    warnings: [],
    recallSummary: { sources: [], itemCount: 0 },
    project: "t",
    sessionId: "s",
    userId: "u",
    machineId: "m",
    now: (): Date => new Date(),
  };
  captureWorkflowOutcome({ ...args, outcome: "run_error", errorMessage: "a" });
  captureWorkflowOutcome({ ...args, outcome: "run_error", errorMessage: "b" });
  captureWorkflowOutcome({ ...args, outcome: "success" });
  const row = db
    .query(
      "SELECT consecutive_failures, quarantined, samples, successes, failures FROM workflow_stats WHERE workflow_name='recovers'",
    )
    .get() as WorkflowStatsRow;
  expect(row.samples).toBe(3);
  expect(row.successes).toBe(1);
  expect(row.failures).toBe(2);
  expect(row.consecutive_failures).toBe(0);
  expect(row.quarantined).toBe(0);
});

type T0CaptureRow = {
  event_type: string;
  provider: null | string;
  model: null | string;
  tokens_in: null | number;
  tokens_out: null | number;
  cost_usd: null | number;
  latency_ms: null | number;
  request_id: null | string;
  payload_json: string;
};

test("stamps workflow_run_id into run and outcome payloads and writes latency_ms to the row", () => {
  const db = freshDb();
  const workflowRunId = "wfrun-capture-1";
  captureWorkflowOutcome({
    db,
    workflowName: "demo",
    outcome: "success",
    latencyMs: 123,
    workflowRunId,
    artifacts: ["/tmp/x.md"],
    warnings: ["w"],
    recallSummary: { sources: ["memory.search"], itemCount: 4 },
    project: "test",
    sessionId: "s1",
    userId: "u",
    machineId: "m",
    now: (): Date => new Date("2026-05-04T15:00:00Z"),
  });

  const rows = db
    .query(
      `SELECT event_type, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, request_id, payload_json
         FROM t0_events
        WHERE event_type IN ('workflow.run', 'workflow.outcome')
        ORDER BY ts`,
    )
    .all() as T0CaptureRow[];

  expect(rows).toHaveLength(2);
  expect(rows[0].event_type).toBe("workflow.run");
  expect(rows[1].event_type).toBe("workflow.outcome");

  for (const row of rows) {
    expect(row.latency_ms).toBe(123);
    expect(row.provider).toBeNull();
    expect(row.model).toBeNull();
    expect(row.tokens_in).toBeNull();
    expect(row.tokens_out).toBeNull();
    expect(row.cost_usd).toBeNull();
    expect(row.request_id).toBeNull();
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload.workflow_run_id).toBe(workflowRunId);
  }

  const outcomePayload = JSON.parse(rows[1].payload_json) as Record<string, unknown>;
  expect(outcomePayload.latency_ms).toBe(123);
});
