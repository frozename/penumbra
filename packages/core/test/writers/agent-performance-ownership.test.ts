import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import type { AgentPerformanceRow } from "@src/schemas/agent-performance.js";
import { routeAgent } from "@src/services/agent-routing.js";
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
const T1 = "2026-05-01T12:00:00.000Z";
const T2 = "2026-05-01T12:05:00.000Z";
const T3 = "2026-05-01T12:10:00.000Z";

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

describe("agent_performance field ownership (#390)", () => {
  let db: Database;
  let writer: AgentPerformanceWriter;
  let seq = 0;

  function row(over: Partial<AgentPerformanceRow>): AgentPerformanceRow {
    seq += 1;
    return {
      performance_id: `p-${String(seq)}`,
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

  function persisted(id = "h1"): PersistedRow {
    const p = db
      .query<PersistedRow, [string]>("SELECT * FROM agent_performance WHERE handoff_id = ?")
      .get(id);
    if (p === null) {
      throw new Error(`no agent_performance row for ${id}`);
    }
    return p;
  }

  function meta(p: PersistedRow): Record<string, unknown> {
    return JSON.parse(p.metadata_json) as Record<string, unknown>;
  }

  function proj(p: PersistedRow): Record<string, unknown> {
    return {
      outcome: p.outcome,
      environment_failure: p.environment_failure,
      failure_class: p.failure_class,
      outcome_source: meta(p).outcome_source,
    };
  }

  function projW(p: PersistedRow): Record<string, unknown> {
    return {
      outcome: p.outcome,
      task_type: p.task_type,
      notes: p.notes,
      artifact_present: p.artifact_present,
      worktree_changed: p.worktree_changed,
      empty_response: p.empty_response,
      verification_present: p.verification_present,
      trust_score: p.trust_score,
      exec_ms: p.exec_ms,
      latency_ms: p.latency_ms,
      reliability_status: p.reliability_status,
      failure_class: p.failure_class,
      environment_failure: p.environment_failure,
      meta: meta(p),
    };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    writer = new AgentPerformanceWriter(db);
    seq = 0;
  });

  it("same-attempt evidence survives a later producer that omits it", () => {
    writer.upsert(
      row({
        artifact_present: "y",
        verification_present: "y",
        worktree_changed: "y",
        empty_response: "n",
        trust_score: 0.9,
        latency_ms: 5000,
        metadata_json: JSON.stringify({ receipt: "r1" }),
      }),
      { identity: { dispatch_attempt: 1, head_sha: SHA_A } },
    );
    writer.upsert(
      row({
        source: "reconciler",
        ts: T2,
        outcome: "merged",
        metadata_json: JSON.stringify({ pr_url: "u" }),
      }),
      { identity: { dispatch_attempt: 1 } },
    );

    const p = persisted();
    const m = meta(p);
    expect(p.verification_present).toBe("y");
    expect(p.artifact_present).toBe("y");
    expect(p.worktree_changed).toBe("y");
    expect(p.empty_response).toBe("n");
    expect(p.trust_score).not.toBeNull();
    expect(p.trust_score).toBeCloseTo(0.9);
    expect(p.latency_ms).toBe(5000);
    expect(p.outcome).toBe("merged");
    expect(m.receipt).toBe("r1");
    expect(m.pr_url).toBe("u");
    expect(m.dispatch_attempt).toBe(1);
    expect(m.head_sha).toBe(SHA_A);
    expect(m.producers).toEqual({ worker: T1, reconciler: T2 });
    expect(m.outcome_source).toBe("reconciler");
  });

  it("verifier->dispatch and dispatch->verifier produce the same row", () => {
    const V = (h: string): AgentPerformanceRow =>
      row({
        handoff_id: h,
        source: "reconciler",
        ts: T2,
        outcome: "completed_with_output",
        verification_present: "y",
        trust_score: 0.8,
        latency_ms: 1000,
        metadata_json: JSON.stringify({ receipt: "v1" }),
      });
    const Dw = (h: string): AgentPerformanceRow =>
      row({
        handoff_id: h,
        outcome: "no_changes",
        artifact_present: "y",
        worktree_changed: "y",
        empty_response: "n",
        exec_ms: 1234,
        latency_ms: 1000,
        notes: "completed",
        reliability_status: "complete",
        metadata_json: JSON.stringify({ reason: "completed", worker_head_sha: SHA_B }),
      });

    writer.upsert(V("h-vd"), { identity: { dispatch_attempt: 1, head_sha: SHA_C } });
    writer.upsert(Dw("h-vd"), { identity: { dispatch_attempt: 1, head_sha: SHA_B } });
    writer.upsert(Dw("h-dv"), { identity: { dispatch_attempt: 1, head_sha: SHA_B } });
    writer.upsert(V("h-dv"), { identity: { dispatch_attempt: 1, head_sha: SHA_C } });

    const vd = persisted("h-vd");
    const dv = persisted("h-dv");
    expect(vd.verification_present).toBe("y");
    expect(vd.trust_score).not.toBeNull();
    expect(vd.trust_score).toBeCloseTo(0.8);
    expect(meta(vd).head_sha).toBe(SHA_C);
    expect(vd.outcome).toBe("completed_with_output");
    expect(vd.notes).toBe("completed");
    expect(meta(vd).worker_head_sha).toBe(SHA_B);
    expect(projW(vd)).toEqual(projW(dv));
  });

  it("a new attempt invalidates prior evidence, metadata and sticky classifications", () => {
    writer.upsert(
      row({
        verification_present: "y",
        artifact_present: "y",
        trust_score: 0.9,
        failure_class: "classifier_declined",
        maestro_takeover_required: "y",
        reliability_status: "complete",
        metadata_json: JSON.stringify({ autocommit_sha: SHA_A }),
      }),
      { identity: { dispatch_attempt: 1, head_sha: SHA_A } },
    );
    writer.upsert(row({ ts: T2, metadata_json: JSON.stringify({ reason: "completed" }) }), {
      identity: { dispatch_attempt: 2 },
    });

    const p = persisted();
    const m = meta(p);
    expect(p.verification_present).toBeNull();
    expect(p.artifact_present).toBeNull();
    expect(p.trust_score).toBeNull();
    expect(p.failure_class).toBeNull();
    expect(p.maestro_takeover_required).toBeNull();
    expect(p.reliability_status).toBeNull();
    expect(m).not.toHaveProperty("autocommit_sha");
    expect(m).not.toHaveProperty("head_sha");
    expect(m.dispatch_attempt).toBe(2);
    expect(m.producers).toEqual({ worker: T2 });
  });

  it("a changed head invalidates head-scoped evidence and keeps attempt facts", () => {
    writer.upsert(
      row({
        source: "reconciler",
        ts: T1,
        verification_present: "y",
        trust_score: 0.9,
        artifact_present: "y",
        worktree_changed: "y",
      }),
      { identity: { dispatch_attempt: 1, head_sha: SHA_A } },
    );
    writer.upsert(row({ source: "reconciler", ts: T2, verification_present: "n" }), {
      identity: { dispatch_attempt: 1, head_sha: SHA_B },
    });

    const p = persisted();
    expect(p.verification_present).toBe("n");
    expect(p.trust_score).toBeNull();
    expect(p.artifact_present).toBe("y");
    expect(p.worktree_changed).toBe("y");
    expect(meta(p).head_sha).toBe(SHA_B);
  });

  it("an explicit negative overrides a prior positive; a no-observation write keeps it", () => {
    writer.upsert(
      row({
        verification_present: "y",
        trust_score: 0.9,
        artifact_present: "y",
        worktree_changed: "y",
        empty_response: "n",
      }),
      { identity: { dispatch_attempt: 1, head_sha: SHA_A } },
    );
    writer.upsert(
      row({
        source: "reconciler",
        ts: T2,
        verification_present: "n",
        trust_score: 0,
        artifact_present: "n",
        worktree_changed: "n",
        empty_response: "y",
      }),
      { identity: { dispatch_attempt: 1, head_sha: SHA_A } },
    );
    writer.upsert(row({ source: "reconciler", ts: T3 }), {
      identity: { dispatch_attempt: 1 },
    });

    const p = persisted();
    expect(p.artifact_present).toBe("n");
    expect(p.worktree_changed).toBe("n");
    expect(p.empty_response).toBe("y");
    expect(p.verification_present).toBe("n");
    expect(p.trust_score).toBe(0);
  });

  it("head-scoped evidence without a head claim is not recorded", () => {
    writer.upsert(row({ verification_present: "y", trust_score: 0.9, artifact_present: "y" }), {
      identity: { dispatch_attempt: 1 },
    });

    const p = persisted();
    const m = meta(p);
    expect(p.verification_present).toBeNull();
    expect(p.trust_score).toBeNull();
    expect(p.artifact_present).toBe("y");
    expect(m).not.toHaveProperty("head_sha");
    expect(m.dispatch_attempt).toBe(1);
  });

  it("a write from an older attempt is a no-op", () => {
    writer.upsert(
      row({
        artifact_present: "y",
        metadata_json: JSON.stringify({ reason: "completed" }),
      }),
      { identity: { dispatch_attempt: 2 } },
    );
    const before = persisted();
    writer.upsert(
      row({
        source: "reconciler",
        ts: T2,
        outcome: "merged",
        metadata_json: JSON.stringify({ pr_url: "u" }),
      }),
      { identity: { dispatch_attempt: 1 } },
    );

    const after = persisted();
    expect(after).toEqual(before);
    expect(after.outcome).toBe("no_changes");
  });

  it("rows without identity keep f7f80f13b replace semantics; stamped rows record provenance", () => {
    writer.upsert(
      row({
        handoff_id: "h-legacy",
        verification_present: "y",
        failure_class: "quota",
        metadata_json: JSON.stringify({ a: 1 }),
      }),
    );
    writer.upsert(
      row({
        handoff_id: "h-legacy",
        source: "reconciler",
        ts: T2,
        metadata_json: '{"b":2}',
      }),
    );
    const legacy = persisted("h-legacy");
    expect(legacy.verification_present).toBeNull();
    expect(legacy.failure_class).toBe("quota");
    expect(legacy.metadata_json).toBe('{"b":2}');

    writer.upsert(row({ handoff_id: "h-stamped" }), {
      identity: { dispatch_attempt: 0 },
    });
    const stamped = persisted("h-stamped");
    const m = meta(stamped);
    expect(m.dispatch_attempt).toBe(0);
    expect(m.producers).toEqual({ worker: T1 });
    expect(m.outcome_source).toBe("worker");
  });

  it("pre-deploy unstamped row: the first stamped write replaces it, then rows merge", () => {
    writer.upsert(
      row({
        artifact_present: "y",
        metadata_json: JSON.stringify({ reason: "completed" }),
      }),
    );
    writer.upsert(
      row({
        source: "reconciler",
        ts: T2,
        outcome: "pr_opened",
        metadata_json: JSON.stringify({ pr_url: "u" }),
      }),
      { identity: { dispatch_attempt: 1 } },
    );

    const p = persisted();
    expect(p.artifact_present).toBeNull();
    expect(meta(p)).toEqual({
      pr_url: "u",
      dispatch_attempt: 1,
      producers: { reconciler: T2 },
      outcome_source: "reconciler",
      notes_source: "reconciler",
    });

    writer.upsert(row({ ts: T3, metadata_json: JSON.stringify({ reason: "completed" }) }), {
      identity: { dispatch_attempt: 1 },
    });
    const p2 = persisted();
    const m2 = meta(p2);
    expect(m2.pr_url).toBe("u");
    expect(m2.reason).toBe("completed");
    expect(p2.outcome).toBe("pr_opened");
  });

  it("a same-attempt worker or non-authoritative write keeps a reconciler/operator verdict", () => {
    writer.upsert(
      row({ handoff_id: "h-a", source: "reconciler", ts: T2, outcome: "test_failed" }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(row({ handoff_id: "h-a", ts: T3, outcome: "no_changes" }), {
      identity: { dispatch_attempt: 1 },
    });
    const ha = persisted("h-a");
    expect(ha.outcome).toBe("test_failed");
    expect(meta(ha).outcome_source).toBe("reconciler");

    writer.upsert(row({ handoff_id: "h-b", source: "operator", ts: T2, outcome: "merged" }), {
      identity: { dispatch_attempt: 1 },
    });
    writer.upsert(row({ handoff_id: "h-b", ts: T3, outcome: "failed" }), {
      identity: { dispatch_attempt: 1 },
    });
    expect(persisted("h-b").outcome).toBe("merged");

    writer.upsert(row({ handoff_id: "h-c", source: "reconciler", ts: T2, outcome: "no_changes" }), {
      identity: { dispatch_attempt: 1 },
    });
    expect(meta(persisted("h-c"))).not.toHaveProperty("outcome_source");
    writer.upsert(row({ handoff_id: "h-c", ts: T3, outcome: "failed" }), {
      identity: { dispatch_attempt: 1 },
    });
    const hc = persisted("h-c");
    expect(hc.outcome).toBe("failed");
    expect(meta(hc).outcome_source).toBe("worker");

    writer.upsert(
      row({ handoff_id: "h-d", source: "reconciler", ts: T2, outcome: "test_failed" }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(row({ handoff_id: "h-d", ts: T3, outcome: "failed" }), {
      identity: { dispatch_attempt: 2 },
    });
    expect(persisted("h-d").outcome).toBe("failed");

    writer.upsert(
      row({ handoff_id: "h-e", source: "reconciler", ts: T2, outcome: "test_failed" }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(row({ handoff_id: "h-e", source: "reconciler", ts: T3, outcome: "no_changes" }), {
      identity: { dispatch_attempt: 1 },
    });
    const he = persisted("h-e");
    expect(he.outcome).toBe("test_failed");
    expect(meta(he).outcome_source).toBe("reconciler");
  });

  it("quota/resource environment failure is sticky within the attempt and cleared by a new attempt", () => {
    writer.upsert(
      row({
        handoff_id: "h-q",
        outcome: "failed",
        environment_failure: "y",
        failure_class: "quota",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(row({ handoff_id: "h-q", source: "reconciler", ts: T2, outcome: "failed" }), {
      identity: { dispatch_attempt: 1 },
    });
    const hq = persisted("h-q");
    expect(hq.environment_failure).toBe("y");
    expect(hq.failure_class).toBe("quota");

    writer.upsert(
      row({
        handoff_id: "h-r",
        source: "reconciler",
        ts: T2,
        outcome: "test_failed",
        environment_failure: "y",
        failure_class: "resource",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(row({ handoff_id: "h-r", ts: T3, outcome: "failed" }), {
      identity: { dispatch_attempt: 1 },
    });
    const hr = persisted("h-r");
    expect(hr.outcome).toBe("test_failed");
    expect(hr.environment_failure).toBe("y");
    expect(hr.failure_class).toBe("resource");

    writer.upsert(row({ handoff_id: "h-r", ts: T3, outcome: "failed" }), {
      identity: { dispatch_attempt: 2 },
    });
    const hr2 = persisted("h-r");
    expect(hr2.environment_failure).toBeNull();
    expect(hr2.failure_class).toBeNull();
  });

  it("a quota failure and an explicit verdict give the same row in either order", () => {
    writer.upsert(
      row({ handoff_id: "h-rq", source: "reconciler", ts: T2, outcome: "test_failed" }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(
      row({
        handoff_id: "h-rq",
        ts: T3,
        outcome: "failed",
        environment_failure: "y",
        failure_class: "quota",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(
      row({
        handoff_id: "h-qr",
        outcome: "failed",
        environment_failure: "y",
        failure_class: "quota",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(
      row({ handoff_id: "h-qr", source: "reconciler", ts: T3, outcome: "test_failed" }),
      { identity: { dispatch_attempt: 1 } },
    );

    const rq = persisted("h-rq");
    const qr = persisted("h-qr");
    expect(rq.outcome).toBe("test_failed");
    expect(rq.environment_failure).toBe("y");
    expect(rq.failure_class).toBe("quota");
    expect(proj(rq)).toEqual(proj(qr));
  });

  it("classifier_declined is recorded beside an explicit verdict in either order", () => {
    writer.upsert(
      row({ handoff_id: "h-rc", source: "reconciler", ts: T2, outcome: "test_failed" }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(
      row({
        handoff_id: "h-rc",
        ts: T3,
        outcome: "failed",
        failure_class: "classifier_declined",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(
      row({
        handoff_id: "h-cr",
        outcome: "failed",
        failure_class: "classifier_declined",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(
      row({ handoff_id: "h-cr", source: "reconciler", ts: T3, outcome: "test_failed" }),
      { identity: { dispatch_attempt: 1 } },
    );

    const rc = persisted("h-rc");
    const cr = persisted("h-cr");
    expect(rc.outcome).toBe("test_failed");
    expect(rc.failure_class).toBeNull();
    expect(rc.environment_failure).toBeNull();
    expect(proj(rc)).toEqual(proj(cr));
  });

  it("a held resource failure survives a same-attempt classifier_declined write and a land, in either order", () => {
    writer.upsert(
      row({
        handoff_id: "h-rcl",
        source: "reconciler",
        ts: T1,
        outcome: "test_failed",
        environment_failure: "y",
        failure_class: "resource",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(
      row({
        handoff_id: "h-rcl",
        ts: T2,
        outcome: "failed",
        failure_class: "classifier_declined",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(row({ handoff_id: "h-rcl", source: "reconciler", ts: T3, outcome: "merged" }), {
      identity: { dispatch_attempt: 1 },
    });
    writer.upsert(
      row({
        handoff_id: "h-crl",
        outcome: "failed",
        failure_class: "classifier_declined",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(
      row({
        handoff_id: "h-crl",
        source: "reconciler",
        ts: T2,
        outcome: "test_failed",
        environment_failure: "y",
        failure_class: "resource",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(row({ handoff_id: "h-crl", source: "reconciler", ts: T3, outcome: "merged" }), {
      identity: { dispatch_attempt: 1 },
    });

    const rcl = persisted("h-rcl");
    const crl = persisted("h-crl");
    expect(rcl.environment_failure).toBe("y");
    expect(rcl.failure_class).toBe("resource");
    expect(rcl.outcome).toBe("merged");
    expect(proj(rcl)).toEqual(proj(crl));
  });

  it("a held quota class survives a same-attempt worker class write and a land (W14b)", () => {
    writer.upsert(
      row({
        handoff_id: "h-qw",
        outcome: "failed",
        environment_failure: "y",
        failure_class: "quota",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(
      row({ handoff_id: "h-qw", ts: T2, outcome: "failed", failure_class: "tool_error" }),
      { identity: { dispatch_attempt: 1 } },
    );
    const afterWorker = persisted("h-qw");
    expect(afterWorker.failure_class).toBe("quota");
    expect(afterWorker.environment_failure).toBe("y");

    writer.upsert(row({ handoff_id: "h-qw", source: "reconciler", ts: T3, outcome: "merged" }), {
      identity: { dispatch_attempt: 1 },
    });
    const afterLand = persisted("h-qw");
    expect(afterLand.failure_class).toBe("quota");
    expect(afterLand.environment_failure).toBe("y");
  });

  it("an environment failure without a quota/resource class is not sticky from either side", () => {
    writer.upsert(
      row({
        handoff_id: "h-ve",
        source: "reconciler",
        ts: T1,
        outcome: "test_failed",
        environment_failure: "y",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(row({ handoff_id: "h-ve", ts: T2, outcome: "failed" }), {
      identity: { dispatch_attempt: 1 },
    });
    const ve = persisted("h-ve");
    expect(ve.outcome).toBe("test_failed");
    expect(ve.environment_failure).toBe("y");

    writer.upsert(row({ handoff_id: "h-ve", source: "reconciler", ts: T3, outcome: "merged" }), {
      identity: { dispatch_attempt: 1 },
    });
    const veAfter = persisted("h-ve");
    expect(veAfter.environment_failure).toBeNull();
    expect(veAfter.failure_class).toBeNull();

    writer.upsert(row({ handoff_id: "h-ve2", source: "reconciler", ts: T1, outcome: "merged" }), {
      identity: { dispatch_attempt: 1 },
    });
    writer.upsert(
      row({
        handoff_id: "h-ve2",
        ts: T2,
        outcome: "failed",
        environment_failure: "y",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    const ve2 = persisted("h-ve2");
    expect(ve2.outcome).toBe("merged");
    expect(ve2.environment_failure).toBeNull();
  });

  it("task_type follows a kept operator verdict, in either order", () => {
    writer.upsert(
      row({
        handoff_id: "h-tt",
        source: "operator",
        ts: T1,
        task_type: "implement_substantial",
        outcome: "merged",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(
      row({
        handoff_id: "h-tt",
        ts: T2,
        task_type: "implement_small",
        outcome: "failed",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(
      row({
        handoff_id: "h-tt2",
        task_type: "implement_small",
        outcome: "failed",
      }),
      { identity: { dispatch_attempt: 1 } },
    );
    writer.upsert(
      row({
        handoff_id: "h-tt2",
        source: "operator",
        ts: T2,
        task_type: "implement_substantial",
        outcome: "merged",
      }),
      { identity: { dispatch_attempt: 1 } },
    );

    const tt = persisted("h-tt");
    const tt2 = persisted("h-tt2");
    expect(tt.task_type).toBe("implement_substantial");
    expect(tt.outcome).toBe("merged");
    expect({ task_type: tt.task_type, outcome: tt.outcome }).toEqual({
      task_type: tt2.task_type,
      outcome: tt2.outcome,
    });
  });

  it("rank exposes the merged trust after a reconciler refresh", () => {
    writer.upsert(
      row({
        handoff_id: "h-trust",
        agent_name: "trust-agent",
        task_type: "implement_small",
        outcome: "merged",
        trust_score: 0.8,
      }),
      { identity: { dispatch_attempt: 1, head_sha: SHA_A } },
    );
    writer.upsert(
      row({
        handoff_id: "h-trust",
        agent_name: "trust-agent",
        task_type: "implement_small",
        source: "reconciler",
        ts: T2,
        outcome: "merged",
      }),
      { identity: { dispatch_attempt: 1 } },
    );

    const out = routeAgent({
      db,
      detail: "rank",
      taskType: "implement_small",
      minSamples: 1,
      includeNeutral: false,
      now: new Date("2026-05-01T13:00:00Z"),
    });
    if (out.detail !== "rank") {
      throw new Error(`routeAgent returned detail="${out.detail}", expected "rank"`);
    }
    const entry = out.candidates.candidates.find((c) => c.agent_name === "trust-agent");
    expect(entry).toBeDefined();
    expect(entry?.avg_trust_score).not.toBeNull();
    expect(entry?.avg_trust_score).toBeCloseTo(0.8);
  });
});
