import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import { AgentPerformanceWriter } from "@src/writers/agent-performance.js";

describe("AgentPerformanceWriter agent_kind", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  it("defaults omitted agent_kind to coding", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "p1",
      ts: "2026-05-01T12:00:00Z",
      handoff_id: "h1",
      conversation_id: null,
      project_id: null,
      agent_name: "claude",
      task_type: "health_check",
      outcome: "failed",
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

    const row = db
      .query<
        { agent_kind: string | null },
        []
      >('SELECT agent_kind FROM agent_performance WHERE handoff_id="h1"')
      .get();
    expect(row?.agent_kind).toBe("coding");
  });

  it("persists long_lived agent_kind when provided", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "p2",
      ts: "2026-05-01T12:05:00Z",
      handoff_id: "h2",
      conversation_id: null,
      project_id: null,
      agent_name: "agent-a",
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

    const row = db
      .query<
        { agent_kind: string | null },
        []
      >('SELECT agent_kind FROM agent_performance WHERE handoff_id="h2"')
      .get();
    expect(row?.agent_kind).toBe("long_lived");
  });
});
