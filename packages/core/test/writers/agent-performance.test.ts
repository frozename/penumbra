import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import { AgentPerformanceWriter } from "@src/writers/agent-performance.js";

interface AgentPerformanceRow {
  performance_id: string;
  outcome: string;
  cost_usd: number | null;
  reliability_status: string | null;
  failure_class: string | null;
  artifact_present: string | null;
  verification_present: string | null;
  maestro_takeover_required: string | null;
  empty_response: string | null;
  worktree_changed: string | null;
  reconcile_status: string | null;
  environment_failure: string | null;
  trust_score: number | null;
}

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    /* darwin sqlite override is best-effort */
  }
}

describe("AgentPerformanceWriter", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  it("upserts by handoff_id", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "p1",
      ts: "2026-04-30T12:00:00Z",
      handoff_id: "h1",
      conversation_id: "c1",
      project_id: "proj",
      agent_name: "claude",
      task_type: "implement_substantial",
      outcome: "pr_opened",
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: 0.25,
      tokens_used: 100,
      latency_ms: 5000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "p2",
      ts: "2026-04-30T12:05:00Z",
      handoff_id: "h1",
      conversation_id: "c1",
      project_id: "proj",
      agent_name: "claude",
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: 0.5,
      tokens_used: 150,
      latency_ms: 6000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    const row = db
      .query<AgentPerformanceRow, []>('SELECT * FROM agent_performance WHERE handoff_id="h1"')
      .get();
    expect(row?.performance_id).toBe("p2");
    expect(row?.outcome).toBe("merged");
    expect(row?.cost_usd).toBe(0.5);
  });

  it("persists reliability fields and defaults omitted fields to null", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "p-reliable",
      ts: "2026-05-01T12:00:00Z",
      handoff_id: "h-reliable",
      conversation_id: "c-reliable",
      project_id: "proj",
      agent_name: "codex",
      task_type: "implement_small",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: 0.25,
      tokens_used: 100,
      latency_ms: 5000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
      reliability_status: "complete",
      failure_class: null,
      artifact_present: "y",
      verification_present: "y",
      maestro_takeover_required: "n",
      empty_response: "n",
      worktree_changed: "y",
      reconcile_status: "merged",
      environment_failure: "n",
      trust_score: 0.95,
    });
    writer.upsert({
      performance_id: "p-legacy",
      ts: "2026-05-01T12:05:00Z",
      handoff_id: "h-legacy",
      conversation_id: "c-legacy",
      project_id: "proj",
      agent_name: "gemini",
      task_type: "implement_small",
      outcome: "no_changes",
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: null,
      source: "worker",
      notes: null,
      metadata_json: "{}",
    });

    const reliable = db
      .query<
        AgentPerformanceRow,
        []
      >('SELECT * FROM agent_performance WHERE handoff_id="h-reliable"')
      .get();
    expect(reliable?.reliability_status).toBe("complete");
    expect(reliable?.artifact_present).toBe("y");
    expect(reliable?.verification_present).toBe("y");
    expect(reliable?.maestro_takeover_required).toBe("n");
    expect(reliable?.empty_response).toBe("n");
    expect(reliable?.worktree_changed).toBe("y");
    expect(reliable?.reconcile_status).toBe("merged");
    expect(reliable?.environment_failure).toBe("n");
    expect(reliable?.trust_score).toBe(0.95);

    const legacy = db
      .query<AgentPerformanceRow, []>('SELECT * FROM agent_performance WHERE handoff_id="h-legacy"')
      .get();
    expect(legacy?.reliability_status).toBeNull();
    expect(legacy?.failure_class).toBeNull();
    expect(legacy?.trust_score).toBeNull();
  });
});
