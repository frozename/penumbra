import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { loadSqliteVec, migrate, workflowReport } from "@src/index.js";
import { EXECUTE_OUTCOMES } from "@src/workflows/outcomes.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

const NOW = new Date("2026-05-08T12:00:00.000Z");

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function event(
  db: Database,
  input: {
    id: string;
    ts: string;
    project_id?: string | null;
    workflow_name?: string | null;
    workflow_run_id?: string | null;
    outcome?: string | null;
    latency_ms?: number | null;
  },
): void {
  const payload: Record<string, unknown> = {};
  if (input.workflow_name !== undefined) payload.workflow_name = input.workflow_name;
  if (input.workflow_run_id !== undefined) payload.workflow_run_id = input.workflow_run_id;
  if (input.outcome !== undefined) payload.outcome = input.outcome;
  if (input.latency_ms !== undefined) payload.latency_ms = input.latency_ms;
  db.run(
    `INSERT INTO t0_events (
       event_id, ts, ingest_ts, source, project_id, user_id, machine_id, event_type, lane,
       payload_json
     ) VALUES (?, ?, ?, 'test', ?, 'u', 'm', 'workflow.outcome', 'unknown', ?)`,
    [input.id, input.ts, input.ts, input.project_id ?? null, JSON.stringify(payload)],
  );
}

function handoff(
  db: Database,
  input: {
    id: string;
    workflow_run_id?: string | null;
    dispatch_kind?: string | null;
    project_id?: string | null;
  },
): void {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status,
       dispatch_kind, workflow_run_id
     ) VALUES (?, '2026-05-08T12:00:00.000Z', ?, ?, 'workflow', 'agent', 'msg', 'complete', ?, ?)`,
    [
      input.id,
      input.project_id ?? null,
      `conv-${input.id}`,
      input.dispatch_kind ?? "workflow",
      input.workflow_run_id ?? null,
    ],
  );
}

function performance(
  db: Database,
  input: {
    handoff_id: string;
    cost_usd?: number | null;
    tokens_used?: number | null;
    framework_overhead_ms?: number | null;
    reliability_status?: string | null;
  },
): void {
  db.run(
    `INSERT INTO agent_performance (
       performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type,
       outcome, cost_usd, tokens_used, framework_overhead_ms, source, reliability_status,
       metadata_json
     ) VALUES (?, '2026-05-08T12:01:00.000Z', ?, ?, 'proj-a', 'agent', 'implement_small',
       'merged', ?, ?, ?, 'test', ?, '{}')`,
    [
      `perf-${input.handoff_id}`,
      input.handoff_id,
      `conv-${input.handoff_id}`,
      input.cost_usd ?? null,
      input.tokens_used ?? null,
      input.framework_overhead_ms ?? null,
      input.reliability_status ?? null,
    ],
  );
}

describe("workflowReport", () => {
  test("aggregates workflow outcome rows before joining fan-out dispatch spend", () => {
    const db = freshDb();
    event(db, {
      id: "run-a-1",
      ts: "2026-05-08T10:00:00.000Z",
      project_id: "proj-a",
      workflow_name: "demo",
      workflow_run_id: "run-a",
      outcome: "success",
      latency_ms: 100,
    });
    event(db, {
      id: "run-b-1",
      ts: "2026-05-08T11:00:00.000Z",
      project_id: "proj-a",
      workflow_name: "demo",
      workflow_run_id: "run-b",
      outcome: "run_error",
      latency_ms: 300,
    });
    handoff(db, { id: "h1", workflow_run_id: "run-a", project_id: "proj-a" });
    handoff(db, { id: "h2", workflow_run_id: "run-a", project_id: "proj-a" });
    handoff(db, { id: "h3", workflow_run_id: "run-a", project_id: "proj-a" });
    performance(db, {
      handoff_id: "h1",
      cost_usd: 1,
      tokens_used: 100,
      framework_overhead_ms: 10,
      reliability_status: "complete",
    });
    performance(db, {
      handoff_id: "h2",
      cost_usd: 2,
      tokens_used: 200,
      framework_overhead_ms: 20,
      reliability_status: "missing_dispatch_end",
    });
    performance(db, {
      handoff_id: "h3",
      cost_usd: null,
      tokens_used: null,
      framework_overhead_ms: null,
      reliability_status: null,
    });

    const out = workflowReport(db, { window_hours: 24, project_id: "proj-a", now: NOW });

    expect(out.window).toEqual({
      from: "2026-05-07T12:00:00.000Z",
      to: "2026-05-08T12:00:00.000Z",
      hours: 24,
    });
    expect(out.rows).toEqual([
      {
        workflow_name: "demo",
        runs: 2,
        ok: 1,
        failed: 1,
        unknown_outcome: 0,
        runs_without_run_id: 0,
        avg_latency_ms: 200,
        dispatches: 3,
        cost_usd: 3,
        tokens: 300,
        dispatches_missing_cost: 1,
        framework_overhead_ms: 30,
        reliability_complete_pct: 0.5,
      },
    ]);
  });

  test("classifies shared outcomes and keeps unknown and null outcomes explicit", () => {
    const db = freshDb();
    for (const [idx, outcome] of EXECUTE_OUTCOMES.entries()) {
      const suffix = String(idx);
      event(db, {
        id: `evt-${suffix}`,
        ts: "2026-05-08T10:00:00.000Z",
        workflow_name: "vocab",
        workflow_run_id: `run-${suffix}`,
        outcome,
      });
    }
    event(db, {
      id: "evt-unknown",
      ts: "2026-05-08T10:05:00.000Z",
      workflow_name: "vocab",
      workflow_run_id: "run-unknown",
      outcome: "new-outcome",
    });
    event(db, {
      id: "evt-null",
      ts: "2026-05-08T10:06:00.000Z",
      workflow_name: "vocab",
      workflow_run_id: "run-null",
      outcome: null,
    });

    const row = workflowReport(db, { window_hours: 24, now: NOW }).rows[0];

    expect(row).toMatchObject({
      workflow_name: "vocab",
      runs: EXECUTE_OUTCOMES.length + 2,
      ok: 1,
      failed: EXECUTE_OUTCOMES.length - 1,
      unknown_outcome: 2,
    });
    expect(row?.runs).toBe((row?.ok ?? 0) + (row?.failed ?? 0) + (row?.unknown_outcome ?? 0));
  });

  test("retains legacy missing-run-id rows without dispatch spend", () => {
    const db = freshDb();
    event(db, {
      id: "legacy",
      ts: "2026-05-08T09:00:00.000Z",
      workflow_name: "legacy",
      outcome: "success",
    });

    expect(workflowReport(db, { window_hours: 24, now: NOW }).rows).toEqual([
      {
        workflow_name: "legacy",
        runs: 1,
        ok: 1,
        failed: 0,
        unknown_outcome: 0,
        runs_without_run_id: 1,
        avg_latency_ms: null,
        dispatches: 0,
        cost_usd: null,
        tokens: null,
        dispatches_missing_cost: 0,
        framework_overhead_ms: null,
        reliability_complete_pct: null,
      },
    ]);
  });

  test("applies inclusive time bounds, project scope, workflow dispatch kind, and duplicate-safe spend", () => {
    const db = freshDb();
    event(db, {
      id: "from",
      ts: "2026-05-07T12:00:00.000Z",
      project_id: "proj-a",
      workflow_name: "demo",
      workflow_run_id: "run-a",
      outcome: "success",
      latency_ms: 100,
    });
    event(db, {
      id: "to",
      ts: "2026-05-08T12:00:00.000Z",
      project_id: "proj-a",
      workflow_name: "demo",
      workflow_run_id: "run-a",
      outcome: "success",
      latency_ms: 300,
    });
    event(db, {
      id: "duplicate",
      ts: "2026-05-08T12:00:00.000Z",
      project_id: "proj-a",
      workflow_name: "demo",
      workflow_run_id: "run-a",
      outcome: "success",
      latency_ms: 500,
    });
    event(db, {
      id: "outside",
      ts: "2026-05-07T11:59:59.999Z",
      project_id: "proj-a",
      workflow_name: "outside",
      workflow_run_id: "run-outside",
      outcome: "success",
    });
    event(db, {
      id: "other-project",
      ts: "2026-05-08T10:00:00.000Z",
      project_id: "proj-b",
      workflow_name: "other",
      workflow_run_id: "run-other",
      outcome: "success",
    });
    handoff(db, { id: "workflow-handoff", workflow_run_id: "run-a", project_id: "proj-a" });
    handoff(db, {
      id: "chain-handoff",
      workflow_run_id: "run-a",
      project_id: "proj-a",
      dispatch_kind: "chain",
    });
    performance(db, { handoff_id: "workflow-handoff", cost_usd: 4 });
    performance(db, { handoff_id: "chain-handoff", cost_usd: 99 });

    const row = workflowReport(db, { window_hours: 24, project_id: "proj-a", now: NOW }).rows[0];

    expect(row).toMatchObject({
      workflow_name: "demo",
      runs: 3,
      avg_latency_ms: 300,
      dispatches: 1,
      cost_usd: 4,
    });
    const projectBRows = workflowReport(db, {
      window_hours: 24,
      project_id: "proj-b",
      now: NOW,
    }).rows;
    expect(projectBRows).toHaveLength(1);
    expect(projectBRows[0]).toMatchObject({ workflow_name: "other", runs: 1, dispatches: 0 });
  });

  test("sorts by runs desc then name and groups missing workflow names as unnamed", () => {
    const db = freshDb();
    event(db, {
      id: "beta-1",
      ts: "2026-05-08T10:00:00.000Z",
      workflow_name: "beta",
      workflow_run_id: "run-beta-1",
      outcome: "success",
    });
    event(db, {
      id: "alpha-1",
      ts: "2026-05-08T10:00:00.000Z",
      workflow_name: "alpha",
      workflow_run_id: "run-alpha-1",
      outcome: "success",
    });
    event(db, {
      id: "alpha-2",
      ts: "2026-05-08T10:05:00.000Z",
      workflow_name: "alpha",
      workflow_run_id: "run-alpha-2",
      outcome: "success",
    });
    event(db, {
      id: "unnamed",
      ts: "2026-05-08T10:10:00.000Z",
      workflow_run_id: "run-unnamed",
      outcome: "success",
    });
    handoff(db, { id: "unnamed-handoff", workflow_run_id: "run-unnamed" });
    performance(db, { handoff_id: "unnamed-handoff", cost_usd: 2 });

    const rows = workflowReport(db, { window_hours: 24, now: NOW }).rows;

    expect(rows.map((row) => row.workflow_name)).toEqual(["alpha", "(unnamed)", "beta"]);
    expect(rows[1]).toMatchObject({ workflow_name: "(unnamed)", cost_usd: 2, dispatches: 1 });
  });

  test("validates report window hours", () => {
    const db = freshDb();
    for (const window_hours of [0, -1, 2161, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => workflowReport(db, { window_hours, now: NOW })).toThrow(
        "window_hours must be an integer from 1 to 2160",
      );
    }
  });

  test("uses the default 168 hour window", () => {
    const db = freshDb();
    expect(workflowReport(db, { now: NOW }).window).toEqual({
      from: "2026-05-01T12:00:00.000Z",
      to: "2026-05-08T12:00:00.000Z",
      hours: 168,
    });
  });
});
