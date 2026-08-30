import { loadSqliteVec, migrate } from "@src/index.js";
import {
  captureAgentPerformanceFromDispatch,
  captureAgentPerformanceFromReconciler,
} from "@src/services/agent-performance-capture.js";
import { type AgentRecommendation, routeAgent } from "@src/services/agent-routing.js";
import { AgentPerformanceWriter } from "@src/writers/agent-performance.js";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

function getRecommendationsViaRoute(
  input: Parameters<typeof routeAgent>[0],
): AgentRecommendation[] {
  const out = routeAgent({ ...input, detail: "summary" });
  if (out.detail !== "summary")
    throw new Error(`routeAgent returned detail="${out.detail}", expected "summary"`);
  return out.recommendations;
}

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

describe("agent performance gate outcome wiring", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  it("stamps gate_outcome from the latest closed lane on reconciler capture", () => {
    db.run(`
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (
        'h1', '2026-05-12T10:00:00Z', 'proj', 'conv', 'maestro', 'claude', NULL, 'Task type: implement_small',
        'completed', 'worker', '2026-05-12T10:02:00Z', 'event-1'
      );
      INSERT INTO lane_ledger (
        lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff, gate_status, metadata_json
      ) VALUES (
        'lane-1', '2026-05-12T10:00:30Z', '2026-05-12T10:01:00Z', 'STANDARD', 'h1', 'reviewer-1', 'passed', '{}'
      );
      INSERT INTO t0_events (
        event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, cost_usd, payload_json
      ) VALUES (
        'u1', '2026-05-12T10:01:00Z', '2026-05-12T10:01:00Z', 'agentchat', 'u', 'm', 'usage-update', 'cli-subscription',
        'anthropic', 'claude', 0.25, '{"handoff_id":"h1","used":100}'
      );
    `);

    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => "perf-1",
      clock: () => new Date("2026-05-12T10:03:00Z"),
      input: { handoff_id: "h1", result: { status: "pr_opened" } },
    });

    expect(row.gate_outcome).toBe("passed");
  });

  it("stamps gate_outcome as null when no closed lane exists", () => {
    db.run(`
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (
        'h2', '2026-05-12T11:00:00Z', 'proj', 'conv', 'maestro', 'claude', NULL, 'Task type: implement_small',
        'completed', 'worker', '2026-05-12T11:02:00Z', 'event-2'
      );
    `);

    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => "perf-2",
      clock: () => new Date("2026-05-12T11:03:00Z"),
      input: { handoff_id: "h2", result: { status: "pr_opened" } },
    });

    expect(row.gate_outcome).toBeNull();
  });

  it("stamps gate_outcome from the lane row on dispatch capture when a closed lane exists", () => {
    db.run(`
      INSERT INTO lane_ledger (
        lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff, gate_status, metadata_json
      ) VALUES (
        'lane-2', '2026-05-12T11:30:00Z', '2026-05-12T11:35:00Z', 'STANDARD', 'h2', 'reviewer-2', 'failed', '{}'
      );
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (
        'h2', '2026-05-12T11:00:00Z', 'proj', 'conv', 'maestro', 'claude', NULL, 'Task type: implement_small',
        'completed', 'worker', '2026-05-12T11:02:00Z', 'event-2'
      );
    `);

    const row = captureAgentPerformanceFromDispatch({
      db,
      uuid: () => "perf-3",
      clock: () => new Date("2026-05-12T11:04:00Z"),
      input: { handoff_id: "h2", reason: "completed" },
    });

    expect(row.gate_outcome).toBe("failed");
  });

  it("does not downgrade an existing passed gate_outcome on later capture", () => {
    db.run(`
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (
        'h-precedence', '2026-05-12T12:00:00Z', 'proj', 'conv', 'maestro', 'claude', NULL, 'Task type: implement_small',
        'completed', 'worker', '2026-05-12T12:02:00Z', 'event-precedence'
      );
      INSERT INTO lane_ledger (
        lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff, gate_status, metadata_json
      ) VALUES (
        'lane-precedence', '2026-05-12T12:00:30Z', '2026-05-12T12:01:00Z', 'STANDARD', 'h-precedence', 'reviewer-precedence', 'failed', '{}'
      );
    `);

    new AgentPerformanceWriter(db).upsert({
      performance_id: "perf-precedence-existing",
      ts: "2026-05-12T12:01:30Z",
      handoff_id: "h-precedence",
      conversation_id: "conv",
      project_id: "proj",
      agent_name: "claude",
      task_type: "implement_small",
      outcome: "merged",
      gate_outcome: "passed",
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: null,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    const row = captureAgentPerformanceFromReconciler({
      db,
      uuid: () => "perf-precedence-new",
      clock: () => new Date("2026-05-12T12:03:00Z"),
      input: { handoff_id: "h-precedence", result: { status: "merged" } },
    });

    const persisted = db
      .query<
        { gate_outcome: string | null },
        [string]
      >(`SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("h-precedence");
    expect(row.gate_outcome).toBe("passed");
    expect(persisted?.gate_outcome).toBe("passed");
  });

  it("keeps failed gate outcomes separate from recommendation successes", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "p1",
      ts: "2026-05-12T12:00:00Z",
      handoff_id: "h3",
      conversation_id: "c3",
      project_id: "proj",
      agent_name: "alpha",
      task_type: "implement_small",
      outcome: "merged",
      gate_outcome: "failed",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    const out = getRecommendationsViaRoute({
      db,
      taskType: "implement_small",
      now: new Date("2026-05-12T13:00:00Z"),
    });

    expect(out[0]?.success_rate).toBe(1);
    expect(out[0]?.gate_verdict_coverage).toBe(1);
    expect(out[0]?.gate_pass_rate).toBe(0);
  });

  it("keeps null gate outcomes separate from recommendation successes", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "p2",
      ts: "2026-05-12T12:30:00Z",
      handoff_id: "h4",
      conversation_id: "c4",
      project_id: "proj",
      agent_name: "beta",
      task_type: "implement_small",
      outcome: "merged",
      gate_outcome: null,
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    const out = getRecommendationsViaRoute({
      db,
      taskType: "implement_small",
      now: new Date("2026-05-12T13:00:00Z"),
    });

    expect(out[0]?.success_rate).toBe(1);
  });
});
