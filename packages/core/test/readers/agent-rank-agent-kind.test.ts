import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, migrate } from "../../src/index.js";
import { routeAgent } from "../../src/services/agent-routing.js";
import type { AgentRankOutput } from "../../src/schemas/agent-performance.js";
import { AgentPerformanceWriter } from "../../src/writers/agent-performance.js";

function rankAgentsViaRoute(input: Parameters<typeof routeAgent>[0]): AgentRankOutput {
  const out = routeAgent({ ...input, detail: "rank" });
  if (out.detail !== "rank")
    throw new Error(`routeAgent returned detail="${out.detail}", expected "rank"`);
  return out.candidates;
}

describe("routeAgent rank mode - agentKind filter", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "p1",
      ts: "2026-05-01T10:00:00Z",
      handoff_id: "h1",
      conversation_id: null,
      project_id: null,
      agent_name: "coding-agent",
      task_type: "health_check",
      outcome: "merged",
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
    writer.upsert({
      performance_id: "p2",
      ts: "2026-05-01T11:00:00Z",
      handoff_id: "h2",
      conversation_id: null,
      project_id: null,
      agent_name: "long-lived-agent",
      task_type: "health_check",
      outcome: "merged",
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: null,
      source: "manual_seed",
      notes: null,
      agent_kind: "long_lived",
      metadata_json: "{}",
    });
  });

  it("defaults to coding rows only", () => {
    const out = rankAgentsViaRoute({
      db,
      taskType: "health_check",
      minSamples: 1,
      includeNeutral: true,
      now: new Date("2026-05-01T12:00:00Z"),
    });

    expect(out.candidates.map((c) => c.agent_name)).toEqual(["coding-agent"]);
  });
});
