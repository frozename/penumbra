import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import type {
  AgentPerformanceCaptureFromDispatch,
  AgentPerformanceCaptureFromReconciler,
  AgentPerformanceRow,
  RecordOperatorAgentPerformanceInput,
} from "@src/schemas/agent-performance.js";
import {
  captureAgentPerformanceFromDispatch,
  captureAgentPerformanceFromReconciler,
} from "@src/services/agent-performance-capture.js";
import { recordOperatorAgentPerformance } from "@src/services/agent-performance-operator.js";
import type { CommitIntegrityEvidence } from "@src/services/dispatch-reliability.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const CLEAN: CommitIntegrityEvidence = {
  base_sha: SHA_A,
  head_sha: SHA_B,
  base_is_ancestor: true,
  identity: { name: "penumbra-worker", email: "worker@penumbra.local" },
  mismatched_commits: [],
  mismatched_total: 0,
};

const AGY_QUOTA_REASON =
  "~/.local/bin/agy: exit code 3 — error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 140h52m55s.\n" +
  'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true}';

interface PersistedRow {
  performance_id: string | null;
  ts: string | null;
  handoff_id: string | null;
  conversation_id: string | null;
  project_id: string | null;
  agent_name: string | null;
  task_type: string | null;
  outcome: string | null;
  gate_outcome: string | null;
  rounds: number | null;
  smoke_pass: string | null;
  reviewer_findings: number | null;
  maestro_score: number | null;
  cost_usd: number | null;
  tokens_used: number | null;
  latency_ms: number | null;
  exec_ms: number | null;
  framework_overhead_ms: number | null;
  source: string | null;
  notes: string | null;
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
  agent_kind: string | null;
  metadata_json: string;
}

describe("producer ownership across captures (#390)", () => {
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

  function operator(
    id: string,
    iso: string,
    input: Omit<RecordOperatorAgentPerformanceInput, "handoff_id">,
  ): AgentPerformanceRow {
    return recordOperatorAgentPerformance({
      db,
      uuid: () => id,
      clock: () => new Date(iso),
      input: { handoff_id: "h1", ...input },
    });
  }

  function persisted(): PersistedRow {
    const p = db
      .query<PersistedRow, [string]>("SELECT * FROM agent_performance WHERE handoff_id = ?")
      .get("h1");
    if (p === null) {
      throw new Error("no agent_performance row for h1");
    }
    return p;
  }

  function meta(p: PersistedRow): Record<string, unknown> {
    return JSON.parse(p.metadata_json) as Record<string, unknown>;
  }

  function proj(p: PersistedRow): Record<string, unknown> {
    const m = meta(p);
    return {
      outcome: p.outcome,
      environment_failure: p.environment_failure,
      failure_class: p.failure_class,
      outcome_source: m.outcome_source,
      dispatch_attempt: m.dispatch_attempt,
    };
  }

  function norm(p: PersistedRow): Record<string, unknown> {
    const { performance_id, ts, metadata_json, ...cols } = p;
    const { producers, ...m } = meta(p);
    return { ...cols, meta: m };
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

  it("dispatch then reconciler keeps dispatch metadata, notes, timing and the worker head", () => {
    insertEvent("dispatch.end", "2026-04-30T12:01:50Z", {
      status: "ok",
      worktree_changed: true,
      committed: true,
      dirty: false,
      wall_ms: 1234,
      commit_integrity: CLEAN,
    });
    const d = dispatch("perf-d", "2026-04-30T12:03:00Z");
    const r = reconcile("perf-r", "2026-04-30T12:04:00Z", {
      status: "pr_opened",
      pr_url: "https://example.test/pull/1",
    });

    const p = persisted();
    const m = meta(p);
    expect(m).toMatchObject(JSON.parse(d.metadata_json) as Record<string, unknown>);
    expect(m.pr_url).toBe("https://example.test/pull/1");
    expect(m.dispatch_attempt).toBe(1);
    expect(m.worker_head_sha).toBe(SHA_B);
    expect(m.producers).toEqual({
      worker: "2026-04-30T12:03:00.000Z",
      reconciler: "2026-04-30T12:04:00.000Z",
    });
    expect(d.notes).not.toBeNull();
    expect(p.notes).toBe(d.notes);
    expect(p.exec_ms).toBe(1234);
    expect(p.outcome).toBe("pr_opened");
    expect(JSON.parse(r.metadata_json)).toEqual({
      pr_url: "https://example.test/pull/1",
    });
  });

  it("reconciler then dispatch keeps the reconciler verdict, its note, pr_url and regression summary", () => {
    reconcile("perf-r", "2026-04-30T12:03:00Z", {
      status: "test_failed",
      pr_url: "https://example.test/pull/2",
      regression_summary: "2 tests failed",
    });
    dispatch("perf-d", "2026-04-30T12:04:00Z");

    const p = persisted();
    const m = meta(p);
    expect(p.outcome).toBe("test_failed");
    expect(p.notes).toBe("2 tests failed");
    expect(m.pr_url).toBe("https://example.test/pull/2");
    expect(m.regression_summary).toBe("2 tests failed");
    expect(m.reason).toBe("completed");
    expect(m.outcome_source).toBe("reconciler");
    expect(m.notes_source).toBe("reconciler");
  });

  it("land re-stamp keeps operator ratings and dispatch metadata", () => {
    dispatch("perf-d", "2026-04-30T12:03:00Z");
    operator("perf-o", "2026-04-30T12:04:00Z", {
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: 2,
      smoke_pass: "y",
      reviewer_findings: 1,
      maestro_score: 4,
    });
    reconcile("perf-r", "2026-04-30T12:05:00Z", { status: "merged", timed_out: false });

    const p = persisted();
    const m = meta(p);
    expect(p.rounds).toBe(2);
    expect(p.smoke_pass).toBe("y");
    expect(p.reviewer_findings).toBe(1);
    expect(p.maestro_score).toBe(4);
    expect(m.reason).toBe("completed");
    expect(m.source).toBe("operator");
    expect(m.timed_out).toBe(false);
    expect(p.outcome).toBe("merged");

    db.prepare(`DELETE FROM agent_performance WHERE handoff_id = 'h1'`).run();
    dispatch("perf-vd", "2026-04-30T12:03:00Z");
    operator("perf-vo", "2026-04-30T12:04:00Z", {
      task_type: "implement_small",
      outcome: "merged",
    });
    reconcile("perf-vr", "2026-04-30T12:05:00Z", { status: "merged" });
    const v = persisted();
    expect(v.task_type).toBe("implement_small");
    expect(v.outcome).toBe("merged");
  });

  it("operator record keeps dispatch timing and metadata", () => {
    insertEvent("dispatch.end", "2026-04-30T12:01:50Z", { status: "ok", wall_ms: 1234 });
    dispatch("perf-d", "2026-04-30T12:03:00Z");
    operator("perf-o", "2026-04-30T12:04:00Z", {
      task_type: "implement_substantial",
      outcome: "merged",
    });

    const p = persisted();
    const m = meta(p);
    expect(p.exec_ms).toBe(1234);
    expect(m.reason).toBe("completed");
    expect(m.source).toBe("operator");
  });

  it("duplicate reconciler captures with different uuid and clock are idempotent", () => {
    dispatch("perf-d", "2026-04-30T12:03:00Z");
    reconcile("perf-r1", "2026-04-30T12:04:00Z", {
      status: "pr_opened",
      pr_url: "https://example.test/pull/5",
    });
    const s1 = persisted();
    reconcile("perf-r2", "2026-04-30T12:06:00Z", {
      status: "pr_opened",
      pr_url: "https://example.test/pull/5",
    });
    const s2 = persisted();

    expect(meta(s2).reason).toBe("completed");
    expect(norm(s2)).toEqual(norm(s1));
    expect(s2.performance_id).toBe("perf-r2");
  });

  it("a new attempt does not inherit the previous attempt's classification, metadata or head", () => {
    insertEvent("dispatch.end", "2026-04-30T12:01:00Z", {
      status: "error",
      classifier_declined: true,
      decline_reason: "provider_safety_refusal",
      commit_integrity: CLEAN,
    });
    dispatch("perf-a1", "2026-04-30T12:02:00Z", { reason: "error" });
    insertEvent("claim", "2026-04-30T12:03:00Z");
    db.prepare(`UPDATE handoffs SET dispatch_attempts = 2 WHERE handoff_id = 'h1'`).run();
    insertEvent("dispatch.end", "2026-04-30T12:04:00Z", {
      status: "ok",
      worktree_changed: true,
      committed: true,
      dirty: false,
    });
    dispatch("perf-a2", "2026-04-30T12:05:00Z");

    const p = persisted();
    const m = meta(p);
    expect(p.failure_class).toBeNull();
    expect(m.dispatch_attempt).toBe(2);
    expect(m).not.toHaveProperty("classifier_declined");
    expect(m).not.toHaveProperty("worker_head_sha");
    expect(m.producers).toEqual({ worker: "2026-04-30T12:05:00.000Z" });
  });

  it("a capture never reads the previous attempt's dispatch.end or tool failures", () => {
    insertEvent("agent.tool_call.failed", "2026-04-30T12:00:50Z", {
      failure_kind: "error",
    });
    insertEvent("dispatch.end", "2026-04-30T12:01:00Z", {
      status: "error",
      classifier_declined: true,
      decline_reason: "x",
      autocommitted: true,
      autocommit_sha: SHA_A,
      commit_integrity: CLEAN,
      wall_ms: 999,
    });
    insertEvent("claim", "2026-04-30T12:03:00Z");
    db.prepare(`UPDATE handoffs SET dispatch_attempts = 2 WHERE handoff_id = 'h1'`).run();
    dispatch("perf-race", "2026-04-30T12:05:00Z", { wall_ms: 4321 });

    const p = persisted();
    const m = meta(p);
    expect(m).not.toHaveProperty("classifier_declined");
    expect(m).not.toHaveProperty("autocommitted");
    expect(m).not.toHaveProperty("worker_head_sha");
    expect(m.tool_failure_count).toBe(0);
    expect(p.failure_class).toBeNull();
    expect(p.exec_ms).toBe(4321);
    expect(m.dispatch_attempt).toBe(2);
  });

  it("a capture never reads the previous attempt's ACP session or lifecycle events", () => {
    insertEvent("dispatch.start", "2026-04-30T12:00:20Z");
    insertEvent("acp.session.start", "2026-04-30T12:00:25Z", {
      framework_overhead_ms: 777,
    });
    insertEvent("dispatch.end", "2026-04-30T12:01:00Z", {
      status: "ok",
      worktree_changed: true,
      committed: true,
      dirty: false,
    });
    insertEvent("claim", "2026-04-30T12:03:00Z");
    db.prepare(`UPDATE handoffs SET dispatch_attempts = 2 WHERE handoff_id = 'h1'`).run();
    dispatch("perf-b", "2026-04-30T12:05:00Z");

    const p = persisted();
    const m = meta(p);
    expect(p.reliability_status).toBe("missing_dispatch_start");
    expect(p.framework_overhead_ms).toBeNull();
    expect(m.dispatch_attempt).toBe(2);
  });

  it("recovery-cancel detection ignores the previous attempt's dispatch.end", () => {
    insertEvent("dispatch.end", "2026-04-30T12:01:00Z", { status: "ok" });
    db.prepare(
      `UPDATE handoffs SET cancel_requested_at = '2026-04-30T12:02:30Z' WHERE handoff_id = 'h1'`,
    ).run();
    insertEvent("claim", "2026-04-30T12:03:00Z");
    db.prepare(`UPDATE handoffs SET dispatch_attempts = 2 WHERE handoff_id = 'h1'`).run();
    dispatch("perf-c", "2026-04-30T12:05:00Z");

    const p = persisted();
    const m = meta(p);
    expect(p.maestro_takeover_required).toBe("y");
    expect(m.dispatch_attempt).toBe(2);
  });

  it("an orphaned attempt's late reconciler write does not touch the current attempt", () => {
    db.prepare(`UPDATE handoffs SET dispatch_attempts = 2 WHERE handoff_id = 'h1'`).run();
    dispatch("perf-d", "2026-04-30T12:03:00Z");
    const before = persisted();
    reconcile(
      "perf-late",
      "2026-04-30T12:06:00Z",
      { status: "merged", pr_url: "https://example.test/pull/9" },
      { dispatch_attempt: 1 },
    );

    expect(persisted()).toEqual(before);

    reconcile(
      "perf-now",
      "2026-04-30T12:07:00Z",
      { status: "pr_opened", pr_url: "https://example.test/pull/10" },
      { dispatch_attempt: 2 },
    );
    expect(meta(persisted()).pr_url).toBe("https://example.test/pull/10");
  });

  it("the worker head prefers the autocommit SHA when the post-autocommit re-probe failed", () => {
    insertEvent("dispatch.end", "2026-04-30T12:01:50Z", {
      status: "ok",
      worktree_changed: true,
      committed: true,
      dirty: false,
      autocommitted: true,
      autocommit_sha: SHA_A,
      commit_integrity: { ...CLEAN, head_sha: SHA_B },
    });
    dispatch("perf-d", "2026-04-30T12:03:00Z");

    expect(meta(persisted()).worker_head_sha).toBe(SHA_A);
  });

  it("an abbreviated autocommit SHA yields no worker head claim", () => {
    insertEvent("dispatch.end", "2026-04-30T12:01:50Z", {
      status: "ok",
      autocommitted: true,
      autocommit_sha: "abc123",
      commit_integrity: CLEAN,
    });
    dispatch("perf-d", "2026-04-30T12:03:00Z");

    const m = meta(persisted());
    expect(m.dispatch_attempt).toBe(1);
    expect(m).not.toHaveProperty("worker_head_sha");
  });

  it("commit_integrity provides the worker head when nothing was autocommitted", () => {
    insertEvent("dispatch.end", "2026-04-30T12:01:50Z", {
      status: "ok",
      worktree_changed: true,
      committed: true,
      dirty: false,
      commit_integrity: CLEAN,
    });
    dispatch("perf-d", "2026-04-30T12:03:00Z");

    expect(meta(persisted()).worker_head_sha).toBe(SHA_B);
  });

  it("a dispatch re-capture clears dispatch-owned keys it no longer reports and keeps the reconciler's", () => {
    insertEvent("dispatch.end", "2026-04-30T12:01:00Z", {
      status: "error",
      classifier_declined: true,
      decline_reason: "provider_safety_refusal",
    });
    dispatch("perf-d1", "2026-04-30T12:02:00Z", { reason: "error" });
    reconcile("perf-r", "2026-04-30T12:03:00Z", {
      status: "pr_opened",
      pr_url: "https://example.test/pull/3",
    });
    insertEvent("dispatch.end", "2026-04-30T12:04:00Z", {
      status: "ok",
      worktree_changed: true,
      committed: true,
      dirty: false,
    });
    dispatch("perf-d2", "2026-04-30T12:05:00Z");

    const m = meta(persisted());
    expect(m.pr_url).toBe("https://example.test/pull/3");
    expect(m).not.toHaveProperty("classifier_declined");
    expect(m).not.toHaveProperty("decline_reason");
    expect(m.reason).toBe("completed");
  });

  it("a later passing reconciler write clears its own regression summary, timed_out flag and note", () => {
    reconcile("perf-r1", "2026-04-30T12:03:00Z", {
      status: "test_failed",
      pr_url: "https://example.test/pull/4",
      regression_summary: "2 tests failed",
      timed_out: true,
    });
    reconcile("perf-r2", "2026-04-30T12:04:00Z", { status: "merged" });

    const p = persisted();
    const m = meta(p);
    expect(m.pr_url).toBe("https://example.test/pull/4");
    expect(m).not.toHaveProperty("regression_summary");
    expect(m).not.toHaveProperty("timed_out");
    expect(p.notes).toBeNull();
    expect(p.outcome).toBe("merged");
  });

  it("a quota environment failure survives a later reconciler no_changes; the carried outcome keeps its worker owner", () => {
    db.prepare(
      `UPDATE handoffs SET use_worktree=1, status='failed', resolution_reason=? WHERE handoff_id='h1'`,
    ).run(AGY_QUOTA_REASON);
    insertEvent("dispatch.end", "2026-04-30T12:02:00Z", {
      status: "error",
      wall_ms: 18247,
      worktree_changed: false,
    });
    dispatch("perf-d", "2026-04-30T12:03:00Z", {
      reason: "error",
      worktree_changed: false,
      dispatch_end_emitted: true,
      final_response_chars: 0,
      has_meaningful_output: false,
    });
    reconcile("perf-r", "2026-04-30T12:04:00Z", { status: "no_changes" });

    const p = persisted();
    const m = meta(p);
    expect(p.environment_failure).toBe("y");
    expect(p.failure_class).toBe("quota");
    expect(p.outcome).toBe("failed");
    expect(m.outcome_source).toBe("worker");
  });

  it("dispatch after a reconciler resource kill keeps the verdict and the environment failure", () => {
    reconcile("perf-r", "2026-04-30T12:03:00Z", {
      status: "test_failed",
      regression_summary: "verification environment error (tests): SIGKILLed",
      verification_environment_error: true,
      resource_killed: true,
    });
    dispatch("perf-d", "2026-04-30T12:04:00Z");

    const p = persisted();
    expect(p.outcome).toBe("test_failed");
    expect(p.environment_failure).toBe("y");
    expect(p.failure_class).toBe("resource");
  });

  it("reconciler no_changes then a failed quota dispatch gives the worker verdict", () => {
    db.prepare(
      `UPDATE handoffs SET use_worktree=1, status='failed', resolution_reason=? WHERE handoff_id='h1'`,
    ).run(AGY_QUOTA_REASON);
    reconcile("perf-r", "2026-04-30T12:03:00Z", { status: "no_changes" });
    insertEvent("dispatch.end", "2026-04-30T12:02:00Z", {
      status: "error",
      wall_ms: 18247,
      worktree_changed: false,
    });
    dispatch("perf-d", "2026-04-30T12:04:00Z", {
      reason: "error",
      worktree_changed: false,
      dispatch_end_emitted: true,
      final_response_chars: 0,
      has_meaningful_output: false,
    });

    const p = persisted();
    const m = meta(p);
    expect(m.outcome_source).toBe("worker");
    expect(p.outcome).toBe("failed");
    expect(p.environment_failure).toBe("y");
    expect(p.failure_class).toBe("quota");
  });

  it("characterization: a closed lane's passed gate_outcome carries into a new attempt (#391)", () => {
    db.prepare(
      `
      INSERT INTO lane_ledger (lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff, gate_status, metadata_json)
      VALUES ('lane-1', '2026-04-30T12:00:30Z', '2026-04-30T12:01:00Z', 'STANDARD', 'h1', 'r1', 'passed', '{}')
    `,
    ).run();
    dispatch("perf-d1", "2026-04-30T12:03:00Z");
    insertEvent("claim", "2026-04-30T12:04:00Z");
    db.prepare(`UPDATE handoffs SET dispatch_attempts = 2 WHERE handoff_id = 'h1'`).run();
    dispatch("perf-d2", "2026-04-30T12:05:00Z");

    const p = persisted();
    expect(p.gate_outcome).toBe("passed");
    expect(meta(p).dispatch_attempt).toBe(2);
  });

  it("characterization: a land re-stamp after a same-attempt resource kill stays an environment failure", () => {
    reconcile("perf-r1", "2026-04-30T12:03:00Z", {
      status: "test_failed",
      regression_summary: "verification environment error (tests): SIGKILLed",
      verification_environment_error: true,
      resource_killed: true,
    });
    reconcile("perf-r2", "2026-04-30T12:04:00Z", { status: "merged", timed_out: false });

    const p = persisted();
    expect(p.environment_failure).toBe("y");
    expect(p.failure_class).toBe("resource");
    expect(p.outcome).toBe("merged");
  });

  it("the reconciler no_changes carry-forward does not cross attempts", () => {
    dispatch("perf-a1", "2026-04-30T12:02:00Z", { reason: "error" });
    insertEvent("claim", "2026-04-30T12:03:00Z");
    db.prepare(`UPDATE handoffs SET dispatch_attempts = 2 WHERE handoff_id = 'h1'`).run();
    reconcile("perf-r", "2026-04-30T12:04:00Z", { status: "no_changes" });

    const p = persisted();
    const m = meta(p);
    expect(p.outcome).toBe("no_changes");
    expect(m.dispatch_attempt).toBe(2);
    expect(m).not.toHaveProperty("reason");
  });

  it("a carried outcome is not a locked verdict", () => {
    dispatch("perf-d1", "2026-04-30T12:02:00Z", { reason: "error" });
    reconcile("perf-r", "2026-04-30T12:03:00Z", { status: "no_changes" });
    expect(persisted().outcome).toBe("failed");
    dispatch("perf-d2", "2026-04-30T12:04:00Z");

    const p = persisted();
    const m = meta(p);
    expect(p.outcome).toBe("no_changes");
    expect(m.outcome_source).toBe("worker");
  });

  it("a promoted reconciler no_changes is not a verdict: both orders give the worker's failure", () => {
    db.prepare(
      `UPDATE handoffs SET chain_task_type = 'review_adversarial' WHERE handoff_id = 'h1'`,
    ).run();
    insertFinalResponse(
      "resp-1",
      "Substantive review output with enough detail to count as a completed response.",
    );

    reconcile("perf-ra", "2026-04-30T12:03:00Z", { status: "no_changes" });
    expect(persisted().outcome).toBe("completed_with_output");
    expect(meta(persisted())).not.toHaveProperty("outcome_source");
    dispatch("perf-da", "2026-04-30T12:04:00Z", { reason: "error" });
    const a = proj(persisted());
    expect(a.outcome_source).toBe("worker");
    expect(a.outcome).toBe("failed");

    db.prepare(`DELETE FROM agent_performance WHERE handoff_id = 'h1'`).run();

    dispatch("perf-db", "2026-04-30T12:05:00Z", { reason: "error" });
    reconcile("perf-rb", "2026-04-30T12:06:00Z", { status: "no_changes" });
    const b = proj(persisted());
    expect(a).toEqual(b);
  });
});
