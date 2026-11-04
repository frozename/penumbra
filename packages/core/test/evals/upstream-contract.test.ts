import { LaneCloseMetadataSchema } from "@penumbra/api-contract";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import {
  AGENT_PERFORMANCE_RESERVED_METADATA_KEYS,
  type AgentPerformanceRow,
  WORKER_OWNED_METADATA_KEYS,
} from "@src/schemas/agent-performance.js";
import { isStaleAttempt, resolveWorkerHeadSha } from "@src/services/agent-performance-identity.js";
import { AgentPerformanceWriter } from "@src/writers/agent-performance.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const T1 = "2026-05-01T12:00:00.000Z";
const T2 = "2026-05-01T12:05:00.000Z";

let rowSeq = 0;

function row(over: Partial<AgentPerformanceRow>): AgentPerformanceRow {
  rowSeq += 1;
  return {
    performance_id: `p-${String(rowSeq)}`,
    ts: T1,
    handoff_id: "h1",
    conversation_id: "c1",
    project_id: "proj",
    agent_name: "claude",
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
    ...over,
  };
}

function commitIntegrity(headSha: string): Record<string, unknown> {
  return {
    base_sha: SHA_A,
    head_sha: headSha,
    base_is_ancestor: true,
    identity: { name: "Worker", email: "worker@example.com" },
    mismatched_commits: [],
    mismatched_total: 0,
  };
}

describe("evals upstream contract (#452)", () => {
  it("reserves exactly the six writer-owned metadata keys", () => {
    expect([...AGENT_PERFORMANCE_RESERVED_METADATA_KEYS]).toEqual([
      "dispatch_attempt",
      "head_sha",
      "producers",
      "outcome_source",
      "notes_source",
      "task_type_source",
    ]);
  });

  it("keeps the autocommit and worker head keys worker-owned", () => {
    expect(WORKER_OWNED_METADATA_KEYS).toContain("autocommitted");
    expect(WORKER_OWNED_METADATA_KEYS).toContain("autocommit_sha");
    expect(WORKER_OWNED_METADATA_KEYS).toContain("worker_head_sha");
  });

  it("resolveWorkerHeadSha prefers a valid autocommit sha over commit_integrity", () => {
    expect(
      resolveWorkerHeadSha({
        autocommitted: true,
        autocommit_sha: SHA_A,
        commit_integrity: commitIntegrity(SHA_B),
      }),
    ).toBe(SHA_A);
  });

  it("resolveWorkerHeadSha never falls back to commit_integrity on a bad autocommit sha", () => {
    expect(
      resolveWorkerHeadSha({
        autocommitted: true,
        autocommit_sha: "not-a-sha",
        commit_integrity: commitIntegrity(SHA_B),
      }),
    ).toBeNull();
  });

  it("resolveWorkerHeadSha reads commit_integrity.head_sha without autocommit", () => {
    expect(resolveWorkerHeadSha({ commit_integrity: commitIntegrity(SHA_B) })).toBe(SHA_B);
  });

  it("resolveWorkerHeadSha returns null for null meta", () => {
    expect(resolveWorkerHeadSha(null)).toBeNull();
  });

  it("two stamped writes leave dispatch_attempt 2", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(db);
    writer.upsert(row({}), { identity: { dispatch_attempt: 1 } });
    writer.upsert(row({ ts: T2 }), { identity: { dispatch_attempt: 2 } });
    const persisted = db
      .query<
        { metadata_json: string },
        [string]
      >("SELECT metadata_json FROM agent_performance WHERE handoff_id = ?")
      .get("h1");
    expect(persisted).not.toBeNull();
    const meta = JSON.parse(persisted!.metadata_json) as Record<string, unknown>;
    expect(meta["dispatch_attempt"]).toBe(2);
    db.close();
  });

  it("isStaleAttempt flags an older stamped attempt", () => {
    expect(isStaleAttempt({ dispatch_attempt: 1 }, 2)).toBe(true);
  });

  it("LaneCloseMetadataSchema rejects head_sha", () => {
    expect(LaneCloseMetadataSchema.safeParse({ head_sha: SHA_A }).success).toBe(false);
  });
});
