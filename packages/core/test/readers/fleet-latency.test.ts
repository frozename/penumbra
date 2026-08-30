import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import { readFleetLatency } from "@src/readers/fleet-latency.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded in this process
  }
}

describe("readFleetLatency", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  function insertHandoff(handoffId: string, agent: string, status = "completed"): void {
    db.prepare(
      `
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
        to_role, message, status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      handoffId,
      "2026-06-03T00:00:00Z",
      "proj",
      `conv-${handoffId}`,
      "maestro",
      agent,
      null,
      "Task type: implement_small\nDo it",
      status,
      status === "completed" ? "worker" : null,
      status === "completed" ? "2026-06-03T00:01:00Z" : null,
      `event-${handoffId}`,
    );
  }

  function insertDispatchEnd(handoffId: string, ts: string, wallMs: number | null): void {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', 'dispatch.end', ?, ?)
    `,
    ).run(
      handoffId,
      "worker-1",
      ts,
      wallMs === null
        ? JSON.stringify({ status: "ok" })
        : JSON.stringify({ status: "ok", wall_ms: wallMs }),
    );
  }

  function insertPerformance(
    handoffId: string,
    agent: string,
    frameworkOverheadMs: number | null,
  ): void {
    db.prepare(
      `
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name,
        task_type, outcome, cost_usd, tokens_used, latency_ms, exec_ms,
        framework_overhead_ms, source, notes, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      `perf-${handoffId}`,
      "2026-06-03T11:55:00.000Z",
      handoffId,
      `conv-${handoffId}`,
      "proj",
      agent,
      "implement_small",
      "merged",
      null,
      null,
      null,
      null,
      frameworkOverheadMs,
      "worker",
      null,
      "{}",
    );
  }

  function insertAcpEvent(
    handoffId: string,
    kind: "acp.server.start" | "acp.session.reuse" | "acp.session.start",
    ts: string,
    frameworkOverheadMs?: number,
  ): void {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, 'worker-1', 'worker', ?, ?, ?)
    `,
    ).run(
      handoffId,
      kind,
      ts,
      JSON.stringify({
        adapter: "stdio-acp",
        ...(frameworkOverheadMs === undefined
          ? {}
          : { framework_overhead_ms: frameworkOverheadMs }),
      }),
    );
  }

  function insertDispatchEndWithOverhead(
    handoffId: string,
    ts: string,
    wallMs: number,
    frameworkOverheadMs: number,
  ): void {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, 'worker-1', 'worker', 'dispatch.end', ?, ?)
    `,
    ).run(
      handoffId,
      ts,
      JSON.stringify({ status: "ok", wall_ms: wallMs, framework_overhead_ms: frameworkOverheadMs }),
    );
  }

  it("returns per-agent p50/p95 wall time, dispatches per hour, and queue depth", () => {
    insertHandoff("a1", "alpha");
    insertHandoff("a2", "alpha");
    insertHandoff("a3", "alpha");
    insertHandoff("a4", "alpha");
    insertHandoff("b1", "beta");
    insertHandoff("b2", "beta");
    insertHandoff("old", "alpha");
    insertHandoff("queued-a", "alpha", "approved");
    insertHandoff("running-a", "alpha", "dispatched");
    insertHandoff("queued-b", "beta", "approved");
    insertHandoff("queued-c", "gamma", "approved");

    insertDispatchEnd("a1", "2026-06-03T11:00:00Z", 100);
    insertDispatchEnd("a2", "2026-06-03T11:10:00Z", 200);
    insertDispatchEnd("a3", "2026-06-03T11:20:00Z", 300);
    insertDispatchEnd("a4", "2026-06-03T11:30:00Z", 400);
    insertDispatchEnd("b1", "2026-06-03T11:40:00Z", 1000);
    insertDispatchEnd("b2", "2026-06-03T11:50:00Z", null);
    insertDispatchEnd("old", "2026-06-03T08:00:00Z", 9999);
    insertPerformance("a1", "alpha", 10);
    insertPerformance("a2", "alpha", 20);
    insertPerformance("a3", "alpha", 30);
    insertPerformance("a4", "alpha", 40);
    insertPerformance("b1", "beta", null);

    const result = readFleetLatency(db, {
      now: "2026-06-03T12:00:00Z",
      window_hours: 2,
    });

    expect(result.window).toEqual({
      from: "2026-06-03T10:00:00.000Z",
      to: "2026-06-03T12:00:00.000Z",
      hours: 2,
    });
    expect(result.agents).toEqual([
      {
        agent_name: "alpha",
        dispatch_count: 4,
        dispatches_per_hour: 2,
        exec_ms_p50: 200,
        exec_ms_p95: 400,
        framework_overhead_ms_p50: 20,
        framework_overhead_ms_p95: 40,
        acp_session_reuse_rate: null,
        framework_overhead_ms_p50_cold: null,
        framework_overhead_ms_p50_reuse: null,
        queue_depth: 2,
      },
      {
        agent_name: "beta",
        dispatch_count: 2,
        dispatches_per_hour: 1,
        exec_ms_p50: 1000,
        exec_ms_p95: 1000,
        framework_overhead_ms_p50: null,
        framework_overhead_ms_p95: null,
        acp_session_reuse_rate: null,
        framework_overhead_ms_p50_cold: null,
        framework_overhead_ms_p50_reuse: null,
        queue_depth: 1,
      },
      {
        agent_name: "gamma",
        dispatch_count: 0,
        dispatches_per_hour: 0,
        exec_ms_p50: null,
        exec_ms_p95: null,
        framework_overhead_ms_p50: null,
        framework_overhead_ms_p95: null,
        acp_session_reuse_rate: null,
        framework_overhead_ms_p50_cold: null,
        framework_overhead_ms_p50_reuse: null,
        queue_depth: 1,
      },
    ]);
  });

  it("computes acp reuse rate and cold/reuse framework-overhead split from dispatch_events lifecycle", () => {
    for (const id of ["c1", "r1"]) insertHandoff(id, "warmish");

    insertAcpEvent("c1", "acp.server.start", "2026-06-03T11:00:00Z");
    insertAcpEvent("c1", "acp.session.start", "2026-06-03T11:00:01Z", 90000);
    insertDispatchEndWithOverhead("c1", "2026-06-03T11:00:05Z", 120000, 120000);

    insertAcpEvent("r1", "acp.session.reuse", "2026-06-03T11:10:00Z");
    insertAcpEvent("r1", "acp.session.start", "2026-06-03T11:10:01Z", 1400);
    insertDispatchEndWithOverhead("r1", "2026-06-03T11:10:05Z", 40000, 40000);

    // A non-ACP agent: no lifecycle events => reuse fields stay null (not 0).
    insertHandoff("p1", "plain");
    insertDispatchEnd("p1", "2026-06-03T11:25:00Z", 300);

    const result = readFleetLatency(db, { now: "2026-06-03T12:00:00Z", window_hours: 2 });
    const warmish = result.agents.find((a) => a.agent_name === "warmish");
    const plain = result.agents.find((a) => a.agent_name === "plain");

    expect(warmish?.acp_session_reuse_rate).toBe(0.5); // 1 reuse / (1 reuse + 1 cold)
    expect(warmish?.framework_overhead_ms_p50_cold).toBe(90000);
    expect(warmish?.framework_overhead_ms_p50_reuse).toBe(1400);
    expect(warmish?.dispatch_count).toBe(2);
    // The existing agent_performance-sourced overhead field is untouched (no perf rows seeded).
    expect(warmish?.framework_overhead_ms_p50).toBeNull();

    // Non-ACP agent: reuse fields are null, not 0.
    expect(plain?.acp_session_reuse_rate).toBeNull();
    expect(plain?.framework_overhead_ms_p50_cold).toBeNull();
    expect(plain?.framework_overhead_ms_p50_reuse).toBeNull();
  });
});
