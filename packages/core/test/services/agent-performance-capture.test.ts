import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it, spyOn } from "bun:test";

import { loadSqliteVec, migrate } from "../../src/index.js";
import { ChainReader } from "../../src/readers/chain.js";
import {
  captureAgentPerformanceFromDispatch,
  captureAgentPerformanceFromReconciler,
  meaningfulOutput,
  MIN_RESPONSE_CHARS,
} from "../../src/services/agent-performance-capture.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

describe("captureAgentPerformanceFromReconciler", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    db.prepare(
      `
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, triggered_by_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "h1",
      "2026-04-30T12:00:00Z",
      "proj",
      "conv",
      "maestro",
      "claude",
      null,
      "Task type: implement_substantial\nImplement the plan",
      "completed",
      "worker",
      "2026-04-30T12:02:00Z",
      "event-1",
    );
    const insertUsage = db.prepare(`
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, cost_usd, payload_json)
      VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'usage-update', 'cli-subscription', 'anthropic', 'claude', ?, ?)
    `);
    insertUsage.run(
      "u1",
      "2026-04-30T12:01:00Z",
      "2026-04-30T12:01:00Z",
      0.1,
      JSON.stringify({ handoff_id: "h1", used: 100 }),
    );
    insertUsage.run(
      "u2",
      "2026-04-30T12:01:30Z",
      "2026-04-30T12:01:30Z",
      0.25,
      JSON.stringify({ handoff_id: "h1", used: 250 }),
    );
  });

  it("calls ChainReader.getResponses exactly once per capture", () => {
    const spy = spyOn(ChainReader.prototype, "getResponses");
    captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-spy",
      clock: () => new Date("2026-04-30T12:05:00Z"),
      input: {
        handoff_id: "h1",
        reason: "completed",
        wall_ms: null,
        framework_overhead_ms: null,
      },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("creates one row with mapped outcome, inferred task type, cost, tokens, and latency", () => {
    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => "perf-1",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: {
        handoff_id: "h1",
        result: { status: "pr_opened", pr_url: "https://example.test/pull/1" },
      },
    });

    expect(row.performance_id).toBe("perf-1");
    expect(row.agent_name).toBe("claude");
    expect(row.task_type).toBe("implement_substantial");
    expect(row.outcome).toBe("pr_opened");
    expect(row.cost_usd).toBe(0.25);
    expect(row.tokens_used).toBe(250);
    expect(row.latency_ms).toBe(120000);
    expect(JSON.parse(row.metadata_json)).toEqual({ pr_url: "https://example.test/pull/1" });
  });

  it("captures worker terminal outcomes so the ledger is fed before reconciliation", () => {
    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-dispatch",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "error" },
    });

    expect(row.performance_id).toBe("perf-dispatch");
    expect(row.agent_name).toBe("claude");
    expect(row.task_type).toBe("implement_substantial");
    expect(row.outcome).toBe("failed");
    expect(row.source).toBe("worker");
    expect(row.notes).toBe("error");
    expect(row.cost_usd).toBe(0.25);
    expect(row.tokens_used).toBe(250);
    expect(JSON.parse(row.metadata_json)).toEqual({
      reason: "error",
      silent_failure: false,
      tool_failure_count: 0,
    });
  });

  it("uses worker-provided wall_ms and framework_overhead_ms when dispatch.end has not landed yet", () => {
    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-worker-metrics",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: {
        handoff_id: "h1",
        reason: "completed",
        wall_ms: 42000,
        framework_overhead_ms: 1234,
      },
    });

    expect(row.exec_ms).toBe(42000);
    expect(row.framework_overhead_ms).toBe(1234);
    const persisted = db
      .query<
        { exec_ms: number | null; framework_overhead_ms: number | null },
        []
      >(`SELECT exec_ms, framework_overhead_ms FROM agent_performance WHERE handoff_id = 'h1'`)
      .get();
    expect(persisted).toEqual({ exec_ms: 42000, framework_overhead_ms: 1234 });
  });

  it("prefers handoff chain_task_type over caller task_type and records the mismatch", () => {
    db.prepare(`UPDATE handoffs SET chain_task_type = ? WHERE handoff_id = ?`).run(
      "review_adversarial",
      "h1",
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-task-type",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: {
        handoff_id: "h1",
        reason: "completed",
        task_type: "implement_substantial",
      },
    });

    expect(row.task_type).toBe("review_adversarial");
    expect(JSON.parse(row.metadata_json)).toEqual(
      expect.objectContaining({
        caller_task_type: "implement_substantial",
        handoff_task_type: "review_adversarial",
        task_type_mismatch: true,
      }),
    );
  });

  it("populates exec_ms from dispatch.end wall_ms without changing enqueue latency", () => {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "dispatch.end",
      "2026-04-30T12:01:00Z",
      JSON.stringify({ status: "ok", wall_ms: 42000 }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-exec",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.latency_ms).toBe(120000);
    expect(row.exec_ms).toBe(42000);
    const persisted = db
      .query<
        { latency_ms: number | null; exec_ms: number | null },
        []
      >(`SELECT latency_ms, exec_ms FROM agent_performance WHERE handoff_id = 'h1'`)
      .get();
    expect(persisted).toEqual({ latency_ms: 120000, exec_ms: 42000 });
  });

  it("persists framework_overhead_ms from dispatch.end meta when present", () => {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "dispatch.end",
      "2026-04-30T12:01:00Z",
      JSON.stringify({ status: "ok", wall_ms: 42000, framework_overhead_ms: 1234 }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-overhead",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.framework_overhead_ms).toBe(1234);
    const persisted = db
      .query<
        { framework_overhead_ms: number | null },
        []
      >(`SELECT framework_overhead_ms FROM agent_performance WHERE handoff_id = 'h1'`)
      .get();
    expect(persisted).toEqual({ framework_overhead_ms: 1234 });
  });

  it("sources framework_overhead_ms from acp.session.start over dispatch.end when both present", () => {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "dispatch.end",
      "2026-04-30T12:01:00Z",
      JSON.stringify({ status: "ok", framework_overhead_ms: 1234 }),
    );
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "acp.session.start",
      "2026-04-30T12:00:30Z",
      JSON.stringify({ framework_overhead_ms: 88 }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-overhead-session-start",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.framework_overhead_ms).toBe(88);
    const persisted = db
      .query<
        { framework_overhead_ms: number | null },
        []
      >(`SELECT framework_overhead_ms FROM agent_performance WHERE handoff_id = 'h1'`)
      .get();
    expect(persisted).toEqual({ framework_overhead_ms: 88 });
  });

  it("sources framework_overhead_ms from acp.session.reuse when session start is absent", () => {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "dispatch.end",
      "2026-04-30T12:01:00Z",
      JSON.stringify({ status: "ok", framework_overhead_ms: 1234 }),
    );
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "acp.session.reuse",
      "2026-04-30T12:00:30Z",
      JSON.stringify({ framework_overhead_ms: 77 }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-overhead-session-reuse",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.framework_overhead_ms).toBe(77);
  });

  it("prefers acp.session.start over an earlier acp.session.reuse on warm dispatches", () => {
    const insertEvt = db.prepare(`
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `);
    // Warm dispatch shape: reuse fires first with only the ms-scale acquire
    // time; session.start follows with the full adapter init cost.
    insertEvt.run(
      "h1",
      "worker-1",
      "acp.session.reuse",
      "2026-04-30T12:00:10Z",
      JSON.stringify({ framework_overhead_ms: 5 }),
    );
    insertEvt.run(
      "h1",
      "worker-1",
      "acp.session.start",
      "2026-04-30T12:00:30Z",
      JSON.stringify({ framework_overhead_ms: 2200 }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-overhead-warm",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.framework_overhead_ms).toBe(2200);
  });

  it("prefers the session event over worker-provided framework_overhead_ms", () => {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "acp.session.start",
      "2026-04-30T12:00:30Z",
      JSON.stringify({ framework_overhead_ms: 88 }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-overhead-input-vs-session",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed", framework_overhead_ms: 1234 },
    });

    expect(row.framework_overhead_ms).toBe(88);
  });

  it("classifies meaningful output at the shared stripped-length threshold", () => {
    const cases: {
      name: string;
      text: string | null | undefined;
      chars: number;
      meaningful: boolean;
    }[] = [
      { name: "null", text: null, chars: 0, meaningful: false },
      { name: "empty", text: "", chars: 0, meaningful: false },
      { name: "whitespace", text: " \n\t ", chars: 0, meaningful: false },
      {
        name: "below threshold",
        text: "x".repeat(MIN_RESPONSE_CHARS - 1),
        chars: 39,
        meaningful: false,
      },
      { name: "at threshold", text: "x".repeat(MIN_RESPONSE_CHARS), chars: 40, meaningful: true },
    ];

    for (const entry of cases) {
      expect(meaningfulOutput(entry.text), entry.name).toEqual({
        chars: entry.chars,
        meaningful: entry.meaningful,
      });
    }
  });

  it("keeps daemon fallback and worker-provided meaningful-output classification aligned", () => {
    db.prepare(`UPDATE handoffs SET chain_task_type = ? WHERE handoff_id = ?`).run(
      "review_adversarial",
      "h1",
    );
    const text = "x".repeat(MIN_RESPONSE_CHARS);
    const workerSummary = meaningfulOutput(text);
    db.prepare(
      `
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, source_detail, user_id, machine_id, event_type, lane, session_id, payload_json)
      VALUES (?, ?, ?, 'agentchat', 'claude', 'claude', 'm', 'agent-response', 'cli-subscription', ?, ?)
    `,
    ).run(
      "threshold-r1",
      "2026-04-30T12:01:55Z",
      "2026-04-30T12:01:55Z",
      "conv",
      JSON.stringify({
        response: text,
      }),
    );

    const fallbackRow = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-threshold-response",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });
    db.prepare(`DELETE FROM agent_performance WHERE handoff_id = ?`).run("h1");
    db.prepare(`DELETE FROM t0_events WHERE event_id = ?`).run("threshold-r1");

    const workerRow = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-threshold-worker",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: {
        handoff_id: "h1",
        reason: "completed",
        final_response_chars: workerSummary.chars,
        has_meaningful_output: workerSummary.meaningful,
      },
    });

    expect(fallbackRow.outcome).toBe("completed_with_output");
    expect(workerRow.outcome).toBe(fallbackRow.outcome);
  });

  it("treats worker-provided meaningful-output fields as authoritative", () => {
    db.prepare(`UPDATE handoffs SET chain_task_type = ? WHERE handoff_id = ?`).run(
      "review_adversarial",
      "h1",
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-worker-meaningful",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: {
        handoff_id: "h1",
        reason: "completed",
        final_response_chars: MIN_RESPONSE_CHARS - 1,
        has_meaningful_output: true,
      },
    });

    expect(row.outcome).toBe("completed_with_output");
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      final_response_chars: MIN_RESPONSE_CHARS - 1,
      has_meaningful_output: true,
    });
  });

  it("falls through to worker-provided framework_overhead_ms when the session value is invalid", () => {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "acp.session.start",
      "2026-04-30T12:00:30Z",
      JSON.stringify({ framework_overhead_ms: -42 }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-overhead-invalid-session",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed", framework_overhead_ms: 1234 },
    });

    expect(row.framework_overhead_ms).toBe(1234);
  });

  it("applies session-event precedence in reconciler capture too", () => {
    const insertEvt = db.prepare(`
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `);
    insertEvt.run(
      "h1",
      "worker-1",
      "acp.session.reuse",
      "2026-04-30T12:00:10Z",
      JSON.stringify({ framework_overhead_ms: 5 }),
    );
    insertEvt.run(
      "h1",
      "worker-1",
      "acp.session.start",
      "2026-04-30T12:00:30Z",
      JSON.stringify({ framework_overhead_ms: 2200 }),
    );
    insertEvt.run(
      "h1",
      "worker-1",
      "dispatch.end",
      "2026-04-30T12:01:00Z",
      JSON.stringify({ status: "ok", wall_ms: 42000, framework_overhead_ms: 1234 }),
    );

    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => "perf-reconciler-session-precedence",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: {
        handoff_id: "h1",
        result: { status: "merged" },
      },
    });

    expect(row.framework_overhead_ms).toBe(2200);
    const persisted = db
      .query<
        { framework_overhead_ms: number | null },
        []
      >(`SELECT framework_overhead_ms FROM agent_performance WHERE handoff_id = 'h1'`)
      .get();
    expect(persisted).toEqual({ framework_overhead_ms: 2200 });
  });

  it("leaves framework_overhead_ms null when dispatch.end omits it", () => {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "dispatch.end",
      "2026-04-30T12:01:00Z",
      JSON.stringify({ status: "ok", wall_ms: 42000 }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-overhead-null",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.framework_overhead_ms).toBeNull();
  });

  it("leaves exec_ms null when dispatch.end wall_ms is absent or not finite", () => {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "dispatch.end",
      "2026-04-30T12:01:00Z",
      JSON.stringify({ status: "ok" }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-exec-null",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.exec_ms).toBeNull();
    const persisted = db
      .query<
        { exec_ms: number | null },
        []
      >(`SELECT exec_ms FROM agent_performance WHERE handoff_id = 'h1'`)
      .get();
    expect(persisted).toEqual({ exec_ms: null });
  });

  it("uses dispatch.end wall_ms and framework_overhead_ms during reconciler capture", () => {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "dispatch.end",
      "2026-04-30T12:01:00Z",
      JSON.stringify({ status: "ok", wall_ms: 42000, framework_overhead_ms: 1234 }),
    );

    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => "perf-reconciler-metrics",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: {
        handoff_id: "h1",
        result: { status: "merged" },
      },
    });

    expect(row.exec_ms).toBe(42000);
    expect(row.framework_overhead_ms).toBe(1234);
    const persisted = db
      .query<
        { exec_ms: number | null; framework_overhead_ms: number | null },
        []
      >(`SELECT exec_ms, framework_overhead_ms FROM agent_performance WHERE handoff_id = 'h1'`)
      .get();
    expect(persisted).toEqual({ exec_ms: 42000, framework_overhead_ms: 1234 });
  });

  it("flags completed dispatches with empty worktree as silent_failure → outcome=failed", () => {
    db.prepare(`UPDATE handoffs SET use_worktree=1 WHERE handoff_id=?`).run("h1");
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "dispatch.end",
      "2026-04-30T12:02:00Z",
      JSON.stringify({ status: "ok", wall_ms: 12000, worktree_changed: false }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-silent",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.outcome).toBe("failed");
    expect(row.notes).toBe("completed (silent_failure: empty worktree)");
    expect(JSON.parse(row.metadata_json)).toEqual({
      reason: "completed",
      silent_failure: true,
      tool_failure_count: 0,
    });
  });

  it("tags classifier declines from dispatch.end meta without changing the failed outcome enum", () => {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "dispatch.end",
      "2026-04-30T12:02:00Z",
      JSON.stringify({
        status: "error",
        classifier_declined: true,
        decline_reason: "provider_safety_refusal",
      }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-classifier-declined",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "error" },
    });

    expect(row.outcome).toBe("failed");
    expect(row.failure_class).toBe("classifier_declined");
    expect(JSON.parse(row.metadata_json)).toEqual(
      expect.objectContaining({
        classifier_declined: true,
        decline_reason: "provider_safety_refusal",
      }),
    );
  });

  it("counts agent.tool_call.failed events into metadata even when worktree did change", () => {
    db.prepare(`UPDATE handoffs SET use_worktree=1 WHERE handoff_id=?`).run("h1");
    const insertEvt = db.prepare(`
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `);
    insertEvt.run(
      "h1",
      "w",
      "agent.tool_call.failed",
      "2026-04-30T12:01:00Z",
      JSON.stringify({ tool_name: "edit" }),
    );
    insertEvt.run(
      "h1",
      "w",
      "agent.tool_call.failed",
      "2026-04-30T12:01:30Z",
      JSON.stringify({ tool_name: "edit" }),
    );
    insertEvt.run(
      "h1",
      "w",
      "dispatch.end",
      "2026-04-30T12:02:00Z",
      JSON.stringify({ status: "ok", worktree_changed: true }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-tools",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.outcome).toBe("no_changes"); // not silent-failure since worktree did change
    expect(JSON.parse(row.metadata_json)).toEqual({
      reason: "completed",
      silent_failure: false,
      tool_failure_count: 2,
    });
  });

  it("uses the routed role as a task-type fallback when the prompt has no explicit type", () => {
    db.prepare(`UPDATE handoffs SET to_role=?, message=? WHERE handoff_id=?`).run(
      "executor",
      "Implement this small change",
      "h1",
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-role",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.task_type).toBe("implement_substantial");
  });

  it("uses chain_task_type before inferring when dispatch capture has no explicit task type", () => {
    db.prepare(
      `UPDATE handoffs SET to_role=NULL, chain_task_type=?, message=? WHERE handoff_id=?`,
    ).run("implement_substantial", "Follow the chain task type", "h1");

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-chain-task",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.task_type).toBe("implement_substantial");
  });

  it("honors explicit capture task_type over routed role fallback", () => {
    db.prepare(`UPDATE handoffs SET to_role=?, message=? WHERE handoff_id=?`).run(
      "executor",
      "Implement this small change",
      "h1",
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-explicit",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed", task_type: "implement_small" },
    });

    expect(row.task_type).toBe("implement_small");
  });

  it("persists reliability_status='complete' for a clean dispatch with full lifecycle and an agent response", () => {
    const insertEvt = db.prepare(`
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `);
    insertEvt.run("h1", "w", "dispatch.start", "2026-04-30T12:00:01Z", null);
    insertEvt.run("h1", "w", "proc.spawn", "2026-04-30T12:00:02Z", null);
    insertEvt.run(
      "h1",
      "w",
      "dispatch.end",
      "2026-04-30T12:01:50Z",
      JSON.stringify({ status: "ok" }),
    );
    db.prepare(
      `
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, source_detail, user_id, machine_id, event_type, lane, session_id, payload_json)
      VALUES (?, ?, ?, 'agentchat', 'claude', 'claude', 'm', 'agent-response', 'cli-subscription', ?, ?)
    `,
    ).run(
      "r1",
      "2026-04-30T12:01:55Z",
      "2026-04-30T12:01:55Z",
      "conv",
      JSON.stringify({ handoff_id: "h1", response: "DONE" }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-clean",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.reliability_status).toBe("complete");
    expect(row.notes).toBe("completed");
  });

  it("promotes review output from legacy agent-response rows without handoff_id", () => {
    db.prepare(`UPDATE handoffs SET chain_task_type = ? WHERE handoff_id = ?`).run(
      "review_adversarial",
      "h1",
    );
    db.prepare(
      `
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, source_detail, user_id, machine_id, event_type, lane, session_id, payload_json)
      VALUES (?, ?, ?, 'agentchat', 'claude', 'claude', 'm', 'agent-response', 'cli-subscription', ?, ?)
    `,
    ).run(
      "legacy-r1",
      "2026-04-30T12:01:55Z",
      "2026-04-30T12:01:55Z",
      "conv",
      JSON.stringify({
        response: "Legacy review output with enough substance to count as a completed response.",
      }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-legacy-response",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.outcome).toBe("completed_with_output");
  });

  it("persists reliability_status='no_worktree_activity' when an implementation task completed without worktree changes", () => {
    db.prepare(`UPDATE handoffs SET use_worktree=1 WHERE handoff_id=?`).run("h1");
    const insertEvt = db.prepare(`
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `);
    insertEvt.run("h1", "w", "dispatch.start", "2026-04-30T12:00:01Z", null);
    insertEvt.run("h1", "w", "proc.spawn", "2026-04-30T12:00:02Z", null);
    insertEvt.run(
      "h1",
      "w",
      "dispatch.end",
      "2026-04-30T12:01:50Z",
      JSON.stringify({ status: "ok", worktree_changed: false }),
    );
    db.prepare(
      `
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, source_detail, user_id, machine_id, event_type, lane, session_id, payload_json)
      VALUES (?, ?, ?, 'agentchat', 'claude', 'claude', 'm', 'agent-response', 'cli-subscription', ?, ?)
    `,
    ).run(
      "r1",
      "2026-04-30T12:01:55Z",
      "2026-04-30T12:01:55Z",
      "conv",
      JSON.stringify({ handoff_id: "h1", response: "done" }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-empty",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.reliability_status).toBe("no_worktree_activity");
    // silent_failure path wins for notes since signals.silent_failure=true.
    expect(row.notes).toBe("completed (silent_failure: empty worktree)");
    expect(row.outcome).toBe("failed");
  });

  it("persists reliability_status='non_terminal_stale' and annotates notes when the classifier recommends cancel", () => {
    // Move handoff into a non-terminal state with a ts well past the stale threshold.
    db.prepare(
      `UPDATE handoffs SET status='dispatched', resolved_at=NULL, ts=? WHERE handoff_id=?`,
    ).run("2026-04-30T11:30:00Z", "h1");

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-stale",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.reliability_status).toBe("non_terminal_stale");
    expect(row.notes).toBe("completed (recommended_action=cancel)");
  });

  it("flags maestro_takeover_required='y' when dispatch.end arrives after cancel_requested_at (recovery cancel)", () => {
    db.prepare(`UPDATE handoffs SET cancel_requested_at=? WHERE handoff_id=?`).run(
      "2026-05-04T10:00:00Z",
      "h1",
    );
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run("h1", "w", "dispatch.end", "2026-05-04T10:00:30Z", JSON.stringify({ status: "ok" }));

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-recovery",
      clock: () => new Date("2026-05-04T10:01:00Z"),
      input: { handoff_id: "h1", reason: "cancelled" },
    });

    expect(row.maestro_takeover_required).toBe("y");
    expect(row.notes).toContain("recovery_cancel");
  });

  it("flags maestro_takeover_required='n' when dispatch.end already happened before cancel_requested_at (late cancel)", () => {
    db.prepare(`UPDATE handoffs SET cancel_requested_at=? WHERE handoff_id=?`).run(
      "2026-05-04T10:00:30Z",
      "h1",
    );
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run("h1", "w", "dispatch.end", "2026-05-04T10:00:00Z", JSON.stringify({ status: "ok" }));

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-late-cancel",
      clock: () => new Date("2026-05-04T10:01:00Z"),
      input: { handoff_id: "h1", reason: "cancelled" },
    });

    expect(row.maestro_takeover_required).toBe("n");
    expect(row.notes ?? "").not.toContain("recovery_cancel");
  });

  it("leaves maestro_takeover_required null when no cancel was issued", () => {
    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-no-cancel",
      clock: () => new Date("2026-05-04T10:01:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(row.maestro_takeover_required).toBeNull();
  });

  it("preserves classifier-decline failure_class when reconciler reports no_changes", () => {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `,
    ).run(
      "h1",
      "worker-1",
      "dispatch.end",
      "2026-04-30T12:02:00Z",
      JSON.stringify({
        status: "error",
        classifier_declined: true,
        decline_reason: "provider_safety_refusal",
      }),
    );

    captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-classifier-declined",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "error" },
    });

    captureAgentPerformanceFromReconciler({
      db,
      uuid: () => "perf-reconciler-no-changes",
      clock: () => new Date("2026-04-30T12:04:00Z"),
      input: {
        handoff_id: "h1",
        result: { status: "no_changes" },
      },
    });

    // Reconciler no_changes must not erase prior dispatch trust signals.
    const persisted = db
      .query<
        { failure_class: string | null },
        []
      >(`SELECT failure_class FROM agent_performance WHERE handoff_id = 'h1'`)
      .get();
    expect(persisted?.failure_class).toBe("classifier_declined");
  });

  it("keeps a silent-failure outcome failed when reconciler reports no_changes", () => {
    db.prepare(`UPDATE handoffs SET use_worktree=1 WHERE handoff_id=?`).run("h1");
    const insertEvt = db.prepare(`
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `);
    insertEvt.run("h1", "w", "dispatch.start", "2026-04-30T12:00:01Z", null);
    insertEvt.run("h1", "w", "proc.spawn", "2026-04-30T12:00:02Z", null);
    insertEvt.run(
      "h1",
      "w",
      "dispatch.end",
      "2026-04-30T12:01:50Z",
      JSON.stringify({ status: "ok", worktree_changed: false }),
    );
    db.prepare(
      `
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, source_detail, user_id, machine_id, event_type, lane, session_id, payload_json)
      VALUES (?, ?, ?, 'agentchat', 'claude', 'claude', 'm', 'agent-response', 'cli-subscription', ?, ?)
    `,
    ).run(
      "r1",
      "2026-04-30T12:01:55Z",
      "2026-04-30T12:01:55Z",
      "conv",
      JSON.stringify({ handoff_id: "h1", response: "done" }),
    );

    captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-empty",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => "perf-reconciler-no-changes",
      clock: () => new Date("2026-04-30T12:04:00Z"),
      input: {
        handoff_id: "h1",
        result: { status: "no_changes" },
      },
    });

    expect(row.outcome).toBe("failed");
    const persisted = db
      .query<
        { outcome: string; reliability_status: string | null },
        []
      >(`SELECT outcome, reliability_status FROM agent_performance WHERE handoff_id = 'h1'`)
      .get();
    expect(persisted).toEqual({
      outcome: "failed",
      reliability_status: "no_worktree_activity",
    });
  });

  it("still lets reconciler merged replace a non-failed dispatch outcome", () => {
    captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-dispatch",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => "perf-reconciler-merged",
      clock: () => new Date("2026-04-30T12:04:00Z"),
      input: {
        handoff_id: "h1",
        result: { status: "merged" },
      },
    });

    expect(row.outcome).toBe("merged");
    const persisted = db
      .query<
        { outcome: string },
        []
      >(`SELECT outcome FROM agent_performance WHERE handoff_id = 'h1'`)
      .get();
    expect(persisted?.outcome).toBe("merged");
  });

  it("lets reconciler capture replace the worker terminal placeholder for the same handoff", () => {
    captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-dispatch",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => "perf-reconciler",
      clock: () => new Date("2026-04-30T12:04:00Z"),
      input: {
        handoff_id: "h1",
        result: { status: "test_failed", regression_summary: "test failed" },
      },
    });

    expect(row.performance_id).toBe("perf-reconciler");
    expect(row.outcome).toBe("test_failed");
    expect(row.source).toBe("reconciler");
    const count = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM agent_performance WHERE handoff_id='h1'`)
      .get();
    expect(count?.n).toBe(1);
  });
  it("computes exact signals for a multi-event handoff with one dispatch.end", () => {
    const insertEvt = db.prepare(
      "INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json) VALUES (?, ?, 'worker', ?, ?, ?)",
    );
    insertEvt.run(
      "h1",
      "w",
      "agent.tool_call.failed",
      "2026-04-30T12:01:00Z",
      JSON.stringify({ tool_name: "edit" }),
    );
    insertEvt.run(
      "h1",
      "w",
      "agent.tool_call.failed",
      "2026-04-30T12:01:30Z",
      JSON.stringify({ tool_name: "edit" }),
    );
    insertEvt.run(
      "h1",
      "w",
      "dispatch.end",
      "2026-04-30T12:02:00Z",
      JSON.stringify({
        status: "ok",
        worktree_changed: true,
        wall_ms: 5000,
        framework_overhead_ms: 100,
        committed: true,
      }),
    );

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-multi",
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input: { handoff_id: "h1", reason: "completed" },
    });

    expect(JSON.parse(row.metadata_json)).toEqual({
      reason: "completed",
      silent_failure: false,
      tool_failure_count: 2,
    });
    expect(row.exec_ms).toBe(5000);
    expect(row.framework_overhead_ms).toBe(100);
  });
});
