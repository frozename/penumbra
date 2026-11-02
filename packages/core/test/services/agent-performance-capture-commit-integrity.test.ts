import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import { AgentPerformanceCaptureFromDispatchSchema } from "@src/schemas/agent-performance.js";
import { captureAgentPerformanceFromDispatch } from "@src/services/agent-performance-capture.js";
import type { CommitIntegrityEvidence } from "@src/services/dispatch-reliability.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

const CLEAN: CommitIntegrityEvidence = {
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  base_is_ancestor: true,
  identity: { name: "penumbra-worker", email: "worker@penumbra.local" },
  mismatched_commits: [],
  mismatched_total: 0,
};

describe("captureAgentPerformanceFromDispatch commit integrity", () => {
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
  });

  function seedDispatchWithCommitIntegrity(commitIntegrity: unknown): void {
    db.prepare(
      `UPDATE handoffs SET use_worktree=1, chain_task_type='health_check', resolved_at='2026-04-30T12:02:00Z' WHERE handoff_id='h1'`,
    ).run();
    const insertEvt = db.prepare(`
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES (?, ?, 'worker', ?, ?, ?)
    `);
    insertEvt.run("h1", "worker-1", "dispatch.start", "2026-04-30T12:00:05Z", JSON.stringify({}));
    insertEvt.run(
      "h1",
      "worker-1",
      "acp.session.start",
      "2026-04-30T12:00:10Z",
      JSON.stringify({}),
    );
    insertEvt.run(
      "h1",
      "worker-1",
      "dispatch.end",
      "2026-04-30T12:01:50Z",
      JSON.stringify({
        status: "ok",
        worktree_changed: true,
        committed: true,
        dirty: false,
        commit_integrity: commitIntegrity,
      }),
    );
  }

  function captureAndReadReliability(performanceId: string): string | null {
    const input = AgentPerformanceCaptureFromDispatchSchema.parse({
      handoff_id: "h1",
      reason: "completed",
      worktree_changed: true,
      final_response_chars: 100,
      has_meaningful_output: true,
      dispatch_end_emitted: true,
    });
    captureAgentPerformanceFromDispatch({
      db,
      uuid: () => performanceId,
      clock: () => new Date("2026-04-30T12:03:00Z"),
      input,
    });
    const stored = db
      .query<
        { reliability_status: string | null },
        [string]
      >(`SELECT reliability_status FROM agent_performance WHERE handoff_id = ?`)
      .get("h1");
    return stored?.reliability_status ?? null;
  }

  it("records commit_identity_mismatch when listed commits fail the identity check", () => {
    seedDispatchWithCommitIntegrity({
      ...CLEAN,
      mismatched_commits: ["c".repeat(40)],
      mismatched_total: 1,
    });

    expect(captureAndReadReliability("perf-ci-listed-mismatch")).toBe("commit_identity_mismatch");
  });

  it("records base_not_ancestor when the branch head does not descend from the base", () => {
    seedDispatchWithCommitIntegrity({ ...CLEAN, base_is_ancestor: false });

    expect(captureAndReadReliability("perf-ci-not-ancestor")).toBe("base_not_ancestor");
  });

  it("records commit_identity_mismatch when mismatched_total exceeds the listed commits", () => {
    seedDispatchWithCommitIntegrity({ ...CLEAN, mismatched_commits: [], mismatched_total: 5 });

    expect(captureAndReadReliability("perf-ci-total-mismatch")).toBe("commit_identity_mismatch");
  });

  it("records complete for clean commit integrity evidence", () => {
    seedDispatchWithCommitIntegrity(CLEAN);

    expect(captureAndReadReliability("perf-ci-clean")).toBe("complete");
  });

  it("ignores malformed commit_integrity evidence and stays complete", () => {
    seedDispatchWithCommitIntegrity({ bogus: true });

    expect(captureAndReadReliability("perf-ci-malformed")).toBe("complete");
  });
});
