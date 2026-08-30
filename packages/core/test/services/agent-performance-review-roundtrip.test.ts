import { loadSqliteVec, migrate, routeAgent } from "@src/index.js";
import { captureAgentPerformanceFromDispatch } from "@src/services/agent-performance-capture.js";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore
  }
}

describe("review_adversarial performance roundtrip", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    // Seed a completed handoff
    db.prepare(
      `
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, use_worktree)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "h1",
      "2026-05-01T12:00:00Z",
      "proj1",
      "c1",
      "maestro",
      "alpha",
      "reviewer",
      "Review-only task: Please review the changes.",
      "completed",
      "worker",
      "2026-05-01T12:05:00Z",
      0,
    );

    // Seed agent-response in t0_events
    db.prepare(
      `
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, event_type, session_id, payload_json, lane, user_id, machine_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "evt1",
      "2026-05-01T12:04:00Z",
      "2026-05-01T12:04:00Z",
      "worker",
      "agent-response",
      "c1",
      JSON.stringify({
        handoff_id: "h1",
        response: "Here is my review: everything looks great. It has over forty characters.",
      }),
      "unknown",
      "alpha",
      "test-machine",
    );
  });

  test("a completed review_adversarial with non-empty response counts as success", () => {
    // 1. Capture performance from the dispatch
    // The task type should be inferred as "review_adversarial" from the message
    captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-1",
      clock: () => new Date("2026-05-01T12:05:00Z"),
      input: {
        handoff_id: "h1",
        task_type: "review_adversarial",
        reason: "completed",
        wall_ms: 1000,
        framework_overhead_ms: 50,
        worktree_changed: false, // Review tasks typically don't change the worktree
      },
    });

    // Verify row was written and outcome is completed_with_output
    const row = db
      .prepare(`SELECT outcome FROM agent_performance WHERE handoff_id = 'h1'`)
      .get() as { outcome: string };
    expect(row).toBeDefined();
    expect(row.outcome).toBe("completed_with_output");

    // 2. Read it back via routeAgent / buildRecommendations
    const routeResult = routeAgent({
      db,
      now: new Date("2026-05-01T12:05:00Z"),
      detail: "rank",
      taskType: "review_adversarial",
      includeNeutral: true,
      // Include alpha in agentchatConfig so it's a known agent
      agentchatConfig: {
        role_routing: { headroom_weighting: false },
        agents: [
          {
            name: "alpha",
            roles: ["reviewer"],
            pricing_mode: "subscription",
            subscription_provider: "prov1",
          },
        ],
      },
      applyPressure: {
        snapshots: [],
      },
    });

    // 3. Assert success_rate > 0 / successes = 1
    const recommendation = (
      routeResult.candidates as
        | {
            candidates: {
              agent_name: string;
              samples: number;
              successes: number;
              success_rate: number;
            }[];
          }
        | undefined
    )?.candidates.find((r) => r.agent_name === "alpha");
    expect(recommendation).toBeDefined();
    expect(recommendation?.samples).toBe(1);
    expect(recommendation?.successes).toBe(1);
    expect(recommendation?.success_rate).toBe(1);
  });

  test("a completed review_adversarial with empty response counts as no_changes (failure)", () => {
    // Seed another handoff and an empty response
    db.prepare(
      `
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, use_worktree)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "h2",
      "2026-05-01T12:10:00Z",
      "proj1",
      "c2",
      "maestro",
      "beta",
      "reviewer",
      "Review-only task: Please review.",
      "completed",
      "worker",
      "2026-05-01T12:15:00Z",
      0,
    );

    // Empty text response
    db.prepare(
      `
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, event_type, session_id, payload_json, lane, user_id, machine_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "evt2",
      "2026-05-01T12:14:00Z",
      "2026-05-01T12:14:00Z",
      "worker",
      "agent-response",
      "c2",
      JSON.stringify({ response: "   " }), // blank text
      "unknown",
      "beta",
      "test-machine",
    );

    captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-2",
      clock: () => new Date("2026-05-01T12:15:00Z"),
      input: {
        handoff_id: "h2",
        task_type: "review_adversarial",
        reason: "completed",
        wall_ms: 1000,
        worktree_changed: false,
      },
    });

    const row = db
      .prepare(`SELECT outcome FROM agent_performance WHERE handoff_id = 'h2'`)
      .get() as { outcome: string };
    expect(row.outcome).toBe("no_changes");

    const routeResult = routeAgent({
      db,
      now: new Date("2026-05-01T12:05:00Z"),
      detail: "rank",
      taskType: "review_adversarial",
      includeNeutral: true,
      agentchatConfig: {
        role_routing: { headroom_weighting: false },
        agents: [
          {
            name: "beta",
            roles: ["reviewer"],
            pricing_mode: "subscription",
            subscription_provider: "prov1",
          },
        ],
      },
      applyPressure: { snapshots: [] },
    });

    const recommendation = (
      routeResult.candidates as
        | {
            candidates: {
              agent_name: string;
              samples: number;
              successes: number;
              success_rate: number;
            }[];
          }
        | undefined
    )?.candidates.find((r) => r.agent_name === "beta");
    expect(recommendation).toBeDefined();
    expect(recommendation?.samples).toBe(1);
    expect(recommendation?.successes).toBe(0);
    expect(recommendation?.success_rate).toBe(0);
  });

  test("worker shape { text } payload parses successfully", () => {
    db.prepare(
      `
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, use_worktree)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "h3",
      "2026-05-01T12:20:00Z",
      "proj1",
      "c3",
      "maestro",
      "gamma",
      "reviewer",
      "Task type: review_adversarial\nPlease review.",
      "completed",
      "worker",
      "2026-05-01T12:25:00Z",
      0,
    );

    db.prepare(
      `
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, event_type, session_id, payload_json, lane, user_id, machine_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "evt3",
      "2026-05-01T12:24:00Z",
      "2026-05-01T12:24:00Z",
      "worker",
      "agent-response",
      "c3",
      JSON.stringify({
        handoff_id: "h3",
        text: "This is a response formatted by the worker, it has over forty chars.",
      }),
      "unknown",
      "gamma",
      "test-machine",
    );

    captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-3",
      clock: () => new Date("2026-05-01T12:25:00Z"),
      input: {
        handoff_id: "h3",
        task_type: "review_adversarial",
        reason: "completed",
        wall_ms: 1000,
        worktree_changed: false,
      },
    });

    const row = db
      .prepare(`SELECT outcome FROM agent_performance WHERE handoff_id = 'h3'`)
      .get() as { outcome: string };
    expect(row.outcome).toBe("completed_with_output");
  });

  test("final response summary fields bypass db read", () => {
    db.prepare(
      `
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, use_worktree)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "h4",
      "2026-05-01T12:30:00Z",
      "proj1",
      "c4",
      "maestro",
      "delta",
      "reviewer",
      "Task type: review_adversarial\nPlease review.",
      "completed",
      "worker",
      "2026-05-01T12:35:00Z",
      0,
    );

    captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-4",
      clock: () => new Date("2026-05-01T12:35:00Z"),
      input: {
        handoff_id: "h4",
        task_type: "review_adversarial",
        reason: "completed",
        wall_ms: 1000,
        worktree_changed: false,
        final_response_chars: 57,
        has_meaningful_output: true,
      },
    });

    const row = db
      .prepare(`SELECT outcome FROM agent_performance WHERE handoff_id = 'h4'`)
      .get() as { outcome: string };
    expect(row.outcome).toBe("completed_with_output");
  });

  test("fallback final response is scoped to the captured handoff", () => {
    db.prepare(
      `
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, use_worktree, chain_task_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "h5",
      "2026-05-01T12:40:00Z",
      "proj1",
      "c5",
      "maestro",
      "echo",
      "reviewer",
      "Task type: review_adversarial\nPlease review.",
      "completed",
      "worker",
      "2026-05-01T12:45:00Z",
      0,
      "review_adversarial",
    );
    db.prepare(
      `
      INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, resolved_by, resolved_at, use_worktree, chain_task_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "h6",
      "2026-05-01T12:41:00Z",
      "proj1",
      "c5",
      "maestro",
      "foxtrot",
      "reviewer",
      "Task type: review_adversarial\nPlease review another change.",
      "completed",
      "worker",
      "2026-05-01T12:46:00Z",
      0,
      "review_adversarial",
    );

    const insertResponse = db.prepare(
      `
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, event_type, session_id, payload_json, lane, user_id, machine_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );
    insertResponse.run(
      "evt-h5",
      "2026-05-01T12:45:00Z",
      "2026-05-01T12:45:00Z",
      "worker",
      "agent-response",
      "c5",
      JSON.stringify({ handoff_id: "h5", response: "short" }),
      "unknown",
      "echo",
      "test-machine",
    );
    insertResponse.run(
      "evt-h6",
      "2026-05-01T12:46:00Z",
      "2026-05-01T12:46:00Z",
      "worker",
      "agent-response",
      "c5",
      JSON.stringify({
        handoff_id: "h6",
        response: "This belongs to the other handoff and is long enough to promote output.",
      }),
      "unknown",
      "foxtrot",
      "test-machine",
    );

    captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-5",
      clock: () => new Date("2026-05-01T12:47:00Z"),
      input: {
        handoff_id: "h5",
        reason: "completed",
        worktree_changed: false,
      },
    });

    const row = db
      .prepare(`SELECT outcome FROM agent_performance WHERE handoff_id = 'h5'`)
      .get() as { outcome: string };
    expect(row.outcome).toBe("no_changes");
  });
});
