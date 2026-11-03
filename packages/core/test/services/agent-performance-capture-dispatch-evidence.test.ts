import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import type {
  AgentPerformanceCaptureFromDispatch,
  AgentPerformanceCaptureFromReconciler,
  AgentPerformanceRow,
} from "@src/schemas/agent-performance.js";
import {
  captureAgentPerformanceFromDispatch,
  captureAgentPerformanceFromReconciler,
} from "@src/services/agent-performance-capture.js";
import type { CommitIntegrityEvidence } from "@src/services/dispatch-reliability.js";
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
const SHA_C = "c".repeat(40);

const CLEAN: CommitIntegrityEvidence = {
  base_sha: SHA_A,
  head_sha: SHA_B,
  base_is_ancestor: true,
  identity: { name: "penumbra-worker", email: "worker@penumbra.local" },
  mismatched_commits: [],
  mismatched_total: 0,
};

const END_TS = "2026-04-30T12:01:50Z";
const CHANGED_COMMITTED: Record<string, unknown> = {
  status: "ok",
  worktree_changed: true,
  committed: true,
  dirty: false,
  commit_integrity: CLEAN,
};
const AUTOCOMMITTED: Record<string, unknown> = {
  status: "ok",
  worktree_changed: true,
  committed: true,
  dirty: false,
  autocommitted: true,
  autocommit_sha: SHA_A,
};
const SAID: Partial<Omit<AgentPerformanceCaptureFromDispatch, "handoff_id">> = {
  worktree_changed: true,
  has_meaningful_output: true,
  final_response_chars: 120,
};
const SAID_NOTHING: Partial<Omit<AgentPerformanceCaptureFromDispatch, "handoff_id">> = {
  worktree_changed: false,
  has_meaningful_output: false,
  final_response_chars: 0,
};
const POSITIVE = { worktree_changed: "y", artifact_present: "y", empty_response: "n" };
const ALL_NULL = {
  worktree_changed: null,
  artifact_present: null,
  empty_response: null,
};

interface EvidenceRow {
  outcome: string;
  worktree_changed: string | null;
  artifact_present: string | null;
  empty_response: string | null;
  verification_present: string | null;
  trust_score: number | null;
  metadata_json: string;
}

type Evidence = Pick<EvidenceRow, "artifact_present" | "empty_response" | "worktree_changed">;

describe("dispatch-side evidence (#451)", () => {
  let db: Database;

  function insertEvent(
    kind: string,
    ts: string,
    meta: Record<string, unknown> | null = null,
  ): void {
    db.prepare(
      `
      INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
      VALUES ('h1', 'worker-1', ?, ?, ?, ?)
    `,
    ).run(
      kind === "claim" ? "daemon" : "worker",
      kind,
      ts,
      meta === null ? null : JSON.stringify(meta),
    );
  }

  function insertFinalResponse(eventId: string, text: string): void {
    db.prepare(
      `
      INSERT INTO t0_events (event_id, ts, ingest_ts, source, source_detail, user_id, machine_id, event_type, lane, session_id, payload_json)
      VALUES (?, ?, ?, 'agentchat', 'claude', 'claude', 'm', 'agent-response', 'cli-subscription', ?, ?)
    `,
    ).run(
      eventId,
      "2026-04-30T12:01:55Z",
      "2026-04-30T12:01:55Z",
      "conv",
      JSON.stringify({ handoff_id: "h1", response: text }),
    );
  }

  function dispatch(
    id: string,
    iso: string,
    extra: Partial<Omit<AgentPerformanceCaptureFromDispatch, "handoff_id">> = {},
  ): AgentPerformanceRow {
    return captureAgentPerformanceFromDispatch({
      db,
      uuid: () => id,
      clock: () => new Date(iso),
      input: { handoff_id: "h1", reason: "completed", ...extra },
    });
  }

  function reconcile(
    id: string,
    iso: string,
    result: AgentPerformanceCaptureFromReconciler["result"],
    extra: Partial<Omit<AgentPerformanceCaptureFromReconciler, "handoff_id" | "result">> = {},
  ): AgentPerformanceRow {
    return captureAgentPerformanceFromReconciler({
      db,
      uuid: () => id,
      clock: () => new Date(iso),
      input: { handoff_id: "h1", result, ...extra },
    });
  }

  function persisted(): EvidenceRow {
    const p = db
      .query<
        EvidenceRow,
        [string]
      >("SELECT outcome, worktree_changed, artifact_present, empty_response, verification_present, trust_score, metadata_json FROM agent_performance WHERE handoff_id = ?")
      .get("h1");
    if (p === null) {
      throw new Error("no agent_performance row for h1");
    }
    return p;
  }

  function meta(p: EvidenceRow): Record<string, unknown> {
    return JSON.parse(p.metadata_json) as Record<string, unknown>;
  }

  function ev(p: EvidenceRow): Evidence {
    return {
      worktree_changed: p.worktree_changed,
      artifact_present: p.artifact_present,
      empty_response: p.empty_response,
    };
  }

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
    db.prepare(`UPDATE handoffs SET dispatch_attempts = 1 WHERE handoff_id = 'h1'`).run();
  });

  it("a changed, committed worktree with a non-empty response records y/y/n as a model commit", () => {
    insertEvent("dispatch.end", END_TS, CHANGED_COMMITTED);
    dispatch("perf-d", "2026-04-30T12:03:00Z", SAID);

    const p = persisted();
    const m = meta(p);
    expect(ev(p)).toEqual(POSITIVE);
    expect(m.artifact_source).toBe("model_commit");
    expect(m.dispatch_attempt).toBe(1);
    expect(p.verification_present).toBeNull();
    expect(p.trust_score).toBeNull();
    expect(m).not.toHaveProperty("head_sha");
  });

  it("a dispatch that changed nothing records explicit negatives, not NULL", () => {
    dispatch("perf-d", "2026-04-30T12:03:00Z", SAID_NOTHING);

    const p = persisted();
    const m = meta(p);
    expect(ev(p)).toEqual({ worktree_changed: "n", artifact_present: "n", empty_response: "y" });
    expect(m.artifact_source).toBe("none");
  });

  it("a false worker hint wins over a contradicting dispatch.end worktree_changed", () => {
    insertEvent("dispatch.end", END_TS, {
      status: "ok",
      worktree_changed: true,
      dirty: false,
    });
    dispatch("perf-d", "2026-04-30T12:03:00Z", { ...SAID_NOTHING, worktree_changed: false });

    const p = persisted();
    const m = meta(p);
    expect(p.worktree_changed).toBe("n");
    expect(p.artifact_present).toBe("n");
    expect(m.artifact_source).toBe("none");
  });

  it("a null worker hint falls back to the dispatch.end worktree_changed", () => {
    insertEvent("dispatch.end", END_TS, {
      status: "ok",
      worktree_changed: false,
      committed: false,
      dirty: false,
    });
    dispatch("perf-d", "2026-04-30T12:03:00Z", { worktree_changed: null });

    const p = persisted();
    expect(p.worktree_changed).toBe("n");
  });

  it("a recovery autocommit is distinguishable from a model-authored commit", () => {
    insertEvent("dispatch.end", END_TS, AUTOCOMMITTED);
    dispatch("perf-d", "2026-04-30T12:03:00Z", SAID);

    const p = persisted();
    const m = meta(p);
    expect(p.artifact_present).toBe("y");
    expect(m.artifact_source).toBe("recovery_autocommit");
    expect(m.autocommitted).toBe(true);
    expect(m.autocommit_sha).toBe(SHA_A);
  });

  it("a dirty, uncommitted worktree is changed but has no artifact", () => {
    insertEvent("dispatch.end", END_TS, {
      status: "ok",
      worktree_changed: true,
      dirty: true,
      committed: false,
    });
    dispatch("perf-d", "2026-04-30T12:03:00Z", SAID);

    const p = persisted();
    const m = meta(p);
    expect(ev(p)).toEqual({ worktree_changed: "y", artifact_present: "n", empty_response: "n" });
    expect(m.artifact_source).toBe("none");
  });

  it("absent signals stay NULL, never false", () => {
    dispatch("perf-d", "2026-04-30T12:03:00Z", { worktree_changed: true });

    const p = persisted();
    const m = meta(p);
    expect(p.worktree_changed).toBe("y");
    expect(p.artifact_present).toBeNull();
    expect(p.empty_response).toBeNull();
    expect(m).not.toHaveProperty("artifact_source");
  });

  it("without worker hints the evidence comes from dispatch.end and the chain read", () => {
    insertEvent("dispatch.end", END_TS, {
      status: "ok",
      worktree_changed: false,
      committed: false,
      dirty: false,
    });
    insertFinalResponse(
      "r1",
      "Reviewed the plan carefully and left a substantive response with real detailed content.",
    );
    dispatch("perf-d", "2026-04-30T12:03:00Z");

    expect(ev(persisted())).toEqual({
      worktree_changed: "n",
      artifact_present: "n",
      empty_response: "n",
    });
  });

  it("dispatch then reconciler refresh keeps the evidence", () => {
    insertEvent("dispatch.end", END_TS, CHANGED_COMMITTED);
    dispatch("perf-d", "2026-04-30T12:03:00Z", SAID);
    reconcile("perf-r", "2026-04-30T12:04:00Z", {
      status: "pr_opened",
      pr_url: "https://example.test/pull/1",
    });

    const p = persisted();
    const m = meta(p);
    expect(ev(p)).toEqual(POSITIVE);
    expect(m.artifact_source).toBe("model_commit");
    expect(p.outcome).toBe("pr_opened");
    expect(m.producers).toEqual({
      worker: "2026-04-30T12:03:00.000Z",
      reconciler: "2026-04-30T12:04:00.000Z",
    });
  });

  it("reconciler then dispatch records the evidence and keeps the reconciler verdict", () => {
    reconcile("perf-r1", "2026-04-30T12:02:30Z", {
      status: "pr_opened",
      pr_url: "https://example.test/pull/1",
    });
    expect(ev(persisted())).toEqual(ALL_NULL);

    insertEvent("dispatch.end", END_TS, CHANGED_COMMITTED);
    dispatch("perf-d", "2026-04-30T12:03:00Z", SAID);

    const p = persisted();
    const m = meta(p);
    expect(ev(p)).toEqual(POSITIVE);
    expect(m.artifact_source).toBe("model_commit");
    expect(p.outcome).toBe("pr_opened");

    reconcile("perf-r2", "2026-04-30T12:05:00Z", {
      status: "pr_opened",
      pr_url: "https://example.test/pull/1",
    });
    const p2 = persisted();
    const m2 = meta(p2);
    expect(ev(p2)).toEqual(POSITIVE);
    expect(m2.artifact_source).toBe("model_commit");
    expect(p2.outcome).toBe("pr_opened");
  });

  it("a re-dispatch starts from unknown", () => {
    insertEvent("dispatch.end", END_TS, CHANGED_COMMITTED);
    dispatch("perf-d", "2026-04-30T12:03:00Z", SAID);
    expect(ev(persisted())).toEqual(POSITIVE);

    insertEvent("claim", "2026-04-30T12:04:00Z");
    db.prepare(`UPDATE handoffs SET dispatch_attempts = 2 WHERE handoff_id = 'h1'`).run();
    dispatch("perf-a2", "2026-04-30T12:05:00Z");

    const p = persisted();
    const m = meta(p);
    expect(ev(p)).toEqual(ALL_NULL);
    expect(m).not.toHaveProperty("artifact_source");
    expect(m.dispatch_attempt).toBe(2);

    reconcile("perf-r2", "2026-04-30T12:06:00Z", {
      status: "pr_opened",
      pr_url: "https://example.test/pull/1",
    });
    const p2 = persisted();
    const m2 = meta(p2);
    expect(ev(p2)).toEqual(ALL_NULL);
    expect(m2).not.toHaveProperty("artifact_source");
  });

  it("late writes from a stale attempt do not touch the current attempt's evidence", () => {
    db.prepare(`UPDATE handoffs SET dispatch_attempts = 2 WHERE handoff_id = 'h1'`).run();
    insertEvent("claim", "2026-04-30T12:00:30Z");
    insertEvent("dispatch.end", END_TS, CHANGED_COMMITTED);
    dispatch("perf-a2", "2026-04-30T12:03:00Z", { ...SAID, dispatch_attempt: 2 });
    expect(ev(persisted())).toEqual(POSITIVE);

    const before = persisted();
    dispatch("perf-late", "2026-04-30T12:06:00Z", { ...SAID_NOTHING, dispatch_attempt: 1 });
    expect(persisted()).toEqual(before);

    reconcile("perf-late-r", "2026-04-30T12:07:00Z", { status: "merged" }, { dispatch_attempt: 1 });
    expect(persisted()).toEqual(before);
  });

  it("a changed head drops head-scoped evidence and keeps the dispatch evidence", () => {
    insertEvent("dispatch.end", END_TS, CHANGED_COMMITTED);
    dispatch("perf-d", "2026-04-30T12:03:00Z", SAID);

    const writer = new AgentPerformanceWriter(db);
    const row: AgentPerformanceRow = {
      performance_id: "v1",
      ts: "2026-04-30T12:04:00.000Z",
      handoff_id: "h1",
      conversation_id: "conv",
      project_id: "proj",
      agent_name: "claude",
      task_type: "implement_substantial",
      outcome: "pr_opened",
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
      verification_present: "y",
      trust_score: 0.9,
    };
    writer.upsert(row, { identity: { dispatch_attempt: 1, head_sha: SHA_B } });
    writer.upsert(
      {
        ...row,
        performance_id: "v2",
        ts: "2026-04-30T12:05:00.000Z",
        verification_present: null,
        trust_score: 0.4,
      },
      { identity: { dispatch_attempt: 1, head_sha: SHA_C } },
    );

    const p = persisted();
    const m = meta(p);
    expect(ev(p)).toEqual(POSITIVE);
    expect(m.artifact_source).toBe("model_commit");
    expect(p.verification_present).toBeNull();
    expect(p.trust_score).toBe(0.4);
    expect(m.head_sha).toBe(SHA_C);
  });

  it("an explicit same-attempt negative replaces the positive and its artifact source", () => {
    insertEvent("dispatch.end", END_TS, CHANGED_COMMITTED);
    dispatch("perf-d", "2026-04-30T12:03:00Z", SAID);
    insertEvent("dispatch.end", "2026-04-30T12:04:00Z", {
      status: "ok",
      worktree_changed: false,
      committed: false,
      dirty: false,
    });
    dispatch("perf-d2", "2026-04-30T12:05:00Z", SAID_NOTHING);

    const p = persisted();
    const m = meta(p);
    expect(ev(p)).toEqual({ worktree_changed: "n", artifact_present: "n", empty_response: "y" });
    expect(m.artifact_source).toBe("none");
  });

  it("production order: the capture precedes dispatch.end, and a later reconciler refresh records the model commit", () => {
    dispatch("perf-d", "2026-04-30T12:01:40Z", SAID);

    const p1 = persisted();
    const m1 = meta(p1);
    expect(ev(p1)).toEqual({ worktree_changed: "y", artifact_present: null, empty_response: "n" });
    expect(m1).not.toHaveProperty("artifact_source");

    reconcile("perf-r1", "2026-04-30T12:02:10Z", {
      status: "pr_opened",
      pr_url: "https://example.test/pull/1",
    });
    expect(ev(persisted())).toEqual({
      worktree_changed: "y",
      artifact_present: null,
      empty_response: "n",
    });

    insertEvent("dispatch.end", END_TS, CHANGED_COMMITTED);
    reconcile("perf-r2", "2026-04-30T12:06:00Z", { status: "merged", timed_out: false });

    const p = persisted();
    const m = meta(p);
    expect(ev(p)).toEqual(POSITIVE);
    expect(m.artifact_source).toBe("model_commit");
    expect(p.outcome).toBe("merged");
  });

  it("production order: a recovery autocommit is recorded by the reconciler refresh", () => {
    dispatch("perf-d", "2026-04-30T12:01:40Z", SAID);

    const p1 = persisted();
    expect(p1.artifact_present).toBeNull();
    expect(p1.worktree_changed).toBe("y");

    insertEvent("dispatch.end", END_TS, AUTOCOMMITTED);
    reconcile("perf-r", "2026-04-30T12:04:00Z", {
      status: "pr_opened",
      pr_url: "https://example.test/pull/1",
    });

    const p = persisted();
    const m = meta(p);
    expect(ev(p)).toEqual(POSITIVE);
    expect(m.artifact_source).toBe("recovery_autocommit");
    expect(m.autocommitted).toBe(true);
    expect(m.autocommit_sha).toBe(SHA_A);
  });
});
