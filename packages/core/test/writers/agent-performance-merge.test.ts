import { beforeAll, describe, expect, it } from "bun:test";

import type { AgentPerformanceRow } from "@src/schemas/agent-performance.js";

type MergeOpts = {
  identity?: { dispatch_attempt: number; head_sha?: string | null };
  outcomeNonAuthoritative?: boolean;
};
type MergeFn = (
  stored: AgentPerformanceRow | null,
  incoming: AgentPerformanceRow,
  opts: MergeOpts,
) => AgentPerformanceRow;

const MERGE_URL = new URL("../../src/writers/agent-performance-merge.ts", import.meta.url).href;

async function loadMerge(): Promise<MergeFn | null> {
  try {
    const mod = (await import(MERGE_URL)) as Record<string, unknown>;
    return typeof mod["mergeAgentPerformance"] === "function"
      ? (mod["mergeAgentPerformance"] as MergeFn)
      : null;
  } catch {
    return null;
  }
}

let merge: MergeFn | null = null;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const T1 = "2026-05-01T12:00:00.000Z";
const T2 = "2026-05-01T12:05:00.000Z";
const T3 = "2026-05-01T12:10:00.000Z";

function r(over: Partial<AgentPerformanceRow>): AgentPerformanceRow {
  return {
    performance_id: "u",
    ts: T1,
    handoff_id: "h",
    conversation_id: null,
    project_id: null,
    agent_name: "a",
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

function at(n: number, head?: string): MergeOpts {
  return head === undefined
    ? { identity: { dispatch_attempt: n } }
    : { identity: { dispatch_attempt: n, head_sha: head } };
}

const NA: MergeOpts = {
  identity: { dispatch_attempt: 1 },
  outcomeNonAuthoritative: true,
};

function meta(x: AgentPerformanceRow): Record<string, unknown> {
  return JSON.parse(x.metadata_json) as Record<string, unknown>;
}

function m(): MergeFn {
  expect(merge).not.toBeNull();
  if (merge === null) {
    throw new Error("unreachable");
  }
  return merge;
}

function seed(over: Partial<AgentPerformanceRow>, opts: MergeOpts): AgentPerformanceRow {
  return m()(null, r(over), opts);
}

beforeAll(async () => {
  merge = await loadMerge();
});

describe("mergeAgentPerformance guard matrix (#390)", () => {
  it("an insert stamps identity, provenance and owners, and strips null and reserved keys", () => {
    const out = m()(
      null,
      r({
        source: "reconciler",
        ts: T2,
        outcome: "merged",
        metadata_json: JSON.stringify({
          pr_url: "u",
          gone: null,
          dispatch_attempt: 9,
          head_sha: SHA_B,
          producers: { x: T1 },
          outcome_source: "operator",
          notes_source: "operator",
        }),
      }),
      at(3),
    );

    expect(meta(out)).toEqual({
      pr_url: "u",
      dispatch_attempt: 3,
      producers: { reconciler: T2 },
      outcome_source: "reconciler",
      notes_source: "reconciler",
    });
    expect(out.gate_outcome).toBeNull();
    expect(out.performance_id).toBe("u");
  });

  it("unstamped writes keep today's replace; a stamped write over an unstamped row replaces it", () => {
    const stored = r({
      failure_class: "quota",
      reliability_status: "complete",
      maestro_takeover_required: "y",
      artifact_present: "y",
      gate_outcome: "passed",
      metadata_json: '{"a":1}',
    });
    const o1 = m()(stored, r({ ts: T2, metadata_json: '{"b":2}' }), {});
    expect(o1.metadata_json).toBe('{"b":2}');
    expect(o1.failure_class).toBe("quota");
    expect(o1.reliability_status).toBe("complete");
    expect(o1.maestro_takeover_required).toBe("y");
    expect(o1.artifact_present).toBeNull();
    expect(o1.gate_outcome).toBe("passed");

    const o2 = m()(
      seed({ artifact_present: "y" }, at(1)),
      r({ ts: T2, metadata_json: '{"b":2}' }),
      {},
    );
    expect(o2.metadata_json).toBe('{"b":2}');
    expect(o2.artifact_present).toBeNull();

    const o3 = m()(stored, r({ ts: T2, source: "reconciler", outcome: "pr_opened" }), at(1));
    expect(o3.artifact_present).toBeNull();
    expect(o3.failure_class).toBe("quota");
    expect(meta(o3)).toEqual({
      dispatch_attempt: 1,
      producers: { reconciler: T2 },
      outcome_source: "reconciler",
      notes_source: "reconciler",
    });
  });

  it("a stale attempt returns the stored row itself", () => {
    const stored = seed({}, at(2));
    expect(m()(stored, r({ source: "reconciler", outcome: "merged", ts: T2 }), at(1))).toBe(stored);
  });

  it("a new attempt resets every merged column and the attempt's metadata, but not gate_outcome", () => {
    const stored = seed(
      {
        artifact_present: "y",
        verification_present: "y",
        trust_score: 0.9,
        failure_class: "classifier_declined",
        reliability_status: "complete",
        maestro_takeover_required: "y",
        rounds: 2,
        notes: "n1",
        environment_failure: "y",
        gate_outcome: "passed",
        metadata_json: JSON.stringify({ autocommit_sha: SHA_A }),
      },
      at(1, SHA_A),
    );
    const out = m()(stored, r({ ts: T2 }), at(2));

    expect(out.artifact_present).toBeNull();
    expect(out.verification_present).toBeNull();
    expect(out.trust_score).toBeNull();
    expect(out.failure_class).toBeNull();
    expect(out.reliability_status).toBeNull();
    expect(out.maestro_takeover_required).toBeNull();
    expect(out.rounds).toBeNull();
    expect(out.notes).toBeNull();
    expect(out.environment_failure).toBeNull();
    expect(out.gate_outcome).toBe("passed");
    expect(meta(out)).toEqual({
      dispatch_attempt: 2,
      producers: { worker: T2 },
      outcome_source: "worker",
      notes_source: "worker",
    });
  });

  it("KA within an attempt: no observation keeps, an explicit value replaces", () => {
    const stored = seed(
      {
        artifact_present: "y",
        worktree_changed: "y",
        empty_response: "n",
        exec_ms: 10,
        rounds: 2,
        latency_ms: 5,
      },
      at(1),
    );

    const keep = m()(stored, r({ source: "reconciler", ts: T2 }), at(1));
    expect(keep.artifact_present).toBe("y");
    expect(keep.worktree_changed).toBe("y");
    expect(keep.empty_response).toBe("n");
    expect(keep.exec_ms).toBe(10);
    expect(keep.rounds).toBe(2);
    expect(keep.latency_ms).toBe(5);

    const flip = m()(
      stored,
      r({
        artifact_present: "n",
        worktree_changed: "n",
        empty_response: "y",
        exec_ms: 0,
      }),
      at(1),
    );
    expect(flip.artifact_present).toBe("n");
    expect(flip.worktree_changed).toBe("n");
    expect(flip.empty_response).toBe("y");
    expect(flip.exec_ms).toBe(0);
  });

  it("KH: the same head keeps, a different head resets, a missing or abbreviated head drops, and a write without KH never moves the head", () => {
    const stored = seed({ verification_present: "y", trust_score: 0.9 }, at(1, SHA_A));

    const same = m()(stored, r({ source: "reconciler", ts: T2 }), at(1, SHA_A));
    expect(same.verification_present).toBe("y");
    expect(same.trust_score).not.toBeNull();
    expect(same.trust_score).toBeCloseTo(0.9);
    expect(meta(same).head_sha).toBe(SHA_A);

    const noKh = m()(stored, r({ ts: T2 }), at(1, SHA_B));
    expect(noKh.verification_present).toBe("y");
    expect(meta(noKh).head_sha).toBe(SHA_A);

    const diff = m()(stored, r({ verification_present: "n" }), at(1, SHA_B));
    expect(diff.verification_present).toBe("n");
    expect(diff.trust_score).toBeNull();
    expect(meta(diff).head_sha).toBe(SHA_B);

    const zero = m()(stored, r({ trust_score: 0 }), at(1, SHA_A));
    expect(zero.trust_score).toBe(0);
    expect(zero.verification_present).toBe("y");

    const noHead = m()(null, r({ verification_present: "y", trust_score: 0.5 }), at(1));
    expect(noHead.verification_present).toBeNull();
    expect(noHead.trust_score).toBeNull();
    expect(meta(noHead)).not.toHaveProperty("head_sha");

    const abbr = m()(null, r({ verification_present: "y" }), at(1, "abc123"));
    expect(abbr.verification_present).toBeNull();
  });

  it("verdict matrix", () => {
    type VerdictCase = readonly [
      Partial<AgentPerformanceRow>,
      MergeOpts,
      Partial<AgentPerformanceRow>,
      MergeOpts,
      AgentPerformanceRow["outcome"],
    ];
    const CASES: readonly VerdictCase[] = [
      [
        { source: "reconciler", outcome: "test_failed" },
        at(1),
        { outcome: "failed" },
        at(1),
        "test_failed",
      ],
      [{ source: "operator", outcome: "merged" }, at(1), { outcome: "failed" }, at(1), "merged"],
      [
        { source: "reconciler", outcome: "no_changes" },
        at(1),
        { outcome: "failed" },
        at(1),
        "failed",
      ],
      [
        { source: "reconciler", outcome: "failed" },
        NA,
        { outcome: "no_changes" },
        at(1),
        "no_changes",
      ],
      [{ outcome: "failed" }, at(1), { source: "reconciler", outcome: "merged" }, at(1), "merged"],
      [
        { source: "reconciler", outcome: "test_failed" },
        at(1),
        { source: "reconciler", outcome: "no_changes" },
        at(1),
        "test_failed",
      ],
      [
        { source: "reconciler", outcome: "test_failed" },
        at(1),
        { source: "operator", outcome: "merged" },
        at(1),
        "merged",
      ],
      [
        { source: "operator", outcome: "merged" },
        at(1),
        { source: "reconciler", outcome: "test_failed" },
        at(1),
        "test_failed",
      ],
      [
        { source: "reconciler", outcome: "test_failed" },
        at(1),
        { outcome: "failed" },
        at(2),
        "failed",
      ],
      [
        { source: "reconciler", outcome: "test_failed" },
        at(1),
        { source: "reconciler", outcome: "completed_with_output" },
        NA,
        "test_failed",
      ],
      [
        { outcome: "failed" },
        at(1),
        { source: "reconciler", outcome: "completed_with_output" },
        NA,
        "completed_with_output",
      ],
    ];
    const got = CASES.map(
      ([so, sOpts, io, iOpts]) => m()(seed(so, sOpts), r({ ts: T2, ...io }), iOpts).outcome,
    );
    expect(got).toEqual(CASES.map((c) => c[4]));
  });

  it("the outcome owner is recorded, kept or omitted, never null, never leaked", () => {
    const a = seed({ source: "reconciler", outcome: "no_changes" }, at(1));
    expect(meta(a)).not.toHaveProperty("outcome_source");
    expect(meta(a).notes_source).toBe("reconciler");

    const b = m()(
      seed({ outcome: "failed" }, at(1)),
      r({ source: "reconciler", outcome: "failed", ts: T2 }),
      NA,
    );
    expect(meta(b).outcome_source).toBe("worker");

    const c = m()(
      seed({ source: "reconciler", outcome: "test_failed" }, at(1)),
      r({ source: "reconciler", outcome: "completed_with_output", ts: T2 }),
      NA,
    );
    expect(c.outcome).toBe("test_failed");
    expect(meta(c).outcome_source).toBe("reconciler");

    const d = m()(
      seed({ outcome: "failed" }, at(1)),
      r({ source: "reconciler", outcome: "completed_with_output", ts: T2 }),
      NA,
    );
    expect(d.outcome).toBe("completed_with_output");
    expect(meta(d)).not.toHaveProperty("outcome_source");

    const e = m()(d, r({ outcome: "failed", ts: T3 }), at(1));
    expect(e.outcome).toBe("failed");
    expect(meta(e).outcome_source).toBe("worker");

    const f = m()(
      seed({ source: "reconciler", outcome: "test_failed" }, at(1)),
      r({ ts: T2 }),
      at(1),
    );
    expect(meta(f).outcome_source).toBe("reconciler");
  });

  it("a kept verdict carries task_type, environment_failure and a non-null note", () => {
    const o1 = m()(
      seed(
        {
          source: "operator",
          outcome: "merged",
          task_type: "implement_substantial",
          notes: "op",
        },
        at(1),
      ),
      r({ ts: T2, outcome: "failed", task_type: "implement_small", notes: "completed" }),
      at(1),
    );
    expect(o1.task_type).toBe("implement_substantial");
    expect(o1.outcome).toBe("merged");
    expect(o1.notes).toBe("op");
    expect(meta(o1).notes_source).toBe("operator");

    const o2 = m()(
      seed({ source: "reconciler", outcome: "test_failed", environment_failure: "y" }, at(1)),
      r({ ts: T2, outcome: "failed", notes: "completed" }),
      at(1),
    );
    expect(o2.environment_failure).toBe("y");
    expect(o2.notes).toBe("completed");
    expect(meta(o2).notes_source).toBe("worker");

    const o3 = m()(
      seed(
        { source: "reconciler", outcome: "test_failed", task_type: "implement_substantial" },
        at(1),
      ),
      r({
        ts: T2,
        source: "reconciler",
        outcome: "merged",
        task_type: "implement_small",
      }),
      at(1),
    );
    expect(o3.task_type).toBe("implement_small");

    const o4 = m()(
      seed({ source: "operator", outcome: "merged", task_type: "implement_small" }, at(1)),
      r({
        ts: T2,
        source: "reconciler",
        outcome: "merged",
        task_type: "implement_substantial",
      }),
      at(1),
    );
    expect(o4.task_type).toBe("implement_small");
  });

  it("environment hold", () => {
    const q1 = m()(
      seed({ outcome: "failed", environment_failure: "y", failure_class: "quota" }, at(1)),
      r({ ts: T2, source: "reconciler", outcome: "merged" }),
      at(1),
    );
    expect(q1.environment_failure).toBe("y");
    expect(q1.failure_class).toBe("quota");
    expect(q1.outcome).toBe("merged");

    const q2 = m()(
      seed(
        {
          source: "reconciler",
          outcome: "test_failed",
          environment_failure: "y",
          failure_class: "resource",
        },
        at(1),
      ),
      r({ ts: T2, outcome: "failed", failure_class: "classifier_declined" }),
      at(1),
    );
    expect(q2.environment_failure).toBe("y");
    expect(q2.failure_class).toBe("resource");

    const q3 = m()(
      seed({ source: "reconciler", outcome: "test_failed", environment_failure: "y" }, at(1)),
      r({ ts: T2, source: "reconciler", outcome: "merged" }),
      at(1),
    );
    expect(q3.environment_failure).toBeNull();

    const q4 = m()(
      seed({ source: "reconciler", outcome: "merged" }, at(1)),
      r({ ts: T2, outcome: "failed", environment_failure: "y" }),
      at(1),
    );
    expect(q4.environment_failure).toBeNull();
    expect(q4.outcome).toBe("merged");

    const q5 = m()(
      seed({ source: "reconciler", outcome: "test_failed" }, at(1)),
      r({
        ts: T2,
        outcome: "failed",
        environment_failure: "y",
        failure_class: "quota",
      }),
      at(1),
    );
    expect(q5.environment_failure).toBe("y");
    expect(q5.failure_class).toBe("quota");
    expect(q5.outcome).toBe("test_failed");

    const q6 = m()(
      seed({ outcome: "failed", environment_failure: "y", failure_class: "quota" }, at(1)),
      r({
        ts: T2,
        source: "reconciler",
        outcome: "merged",
        environment_failure: "y",
        failure_class: "resource",
      }),
      at(1),
    );
    expect(q6.failure_class).toBe("resource");

    const q7 = m()(
      seed({ outcome: "failed", environment_failure: "y", failure_class: "quota" }, at(1)),
      r({ ts: T2, outcome: "failed" }),
      at(2),
    );
    expect(q7.environment_failure).toBeNull();
    expect(q7.failure_class).toBeNull();

    const q8 = m()(
      seed({ source: "reconciler", outcome: "test_failed" }, at(1)),
      r({ ts: T2, outcome: "failed", failure_class: "classifier_declined" }),
      at(1),
    );
    expect(q8.outcome).toBe("test_failed");
    expect(q8.failure_class).toBeNull();

    const q9 = m()(
      seed({ outcome: "failed", failure_class: "classifier_declined" }, at(1)),
      r({ ts: T2, source: "reconciler", outcome: "test_failed" }),
      at(1),
    );
    expect(q9.outcome).toBe("test_failed");
    expect(q9.failure_class).toBeNull();
  });

  it("notes ownership", () => {
    const n1 = m()(
      seed({ notes: "completed" }, at(1)),
      r({ source: "reconciler", outcome: "pr_opened", ts: T2 }),
      at(1),
    );
    expect(n1.notes).toBe("completed");
    expect(meta(n1).notes_source).toBe("worker");

    const n2 = m()(
      seed({ source: "reconciler", outcome: "test_failed", notes: "x" }, at(1)),
      r({ source: "reconciler", outcome: "merged", ts: T2 }),
      at(1),
    );
    expect(n2.notes).toBeNull();
    expect(meta(n2).notes_source).toBe("reconciler");

    const n3 = m()(
      seed({ source: "reconciler", outcome: "test_failed", notes: "x" }, at(1)),
      r({ outcome: "failed", notes: "completed", ts: T2 }),
      at(1),
    );
    expect(n3.notes).toBe("x");
    expect(meta(n3).notes_source).toBe("reconciler");

    const n4 = m()(seed({ notes: "a" }, at(1)), r({ notes: "b", ts: T2 }), at(1));
    expect(n4.notes).toBe("b");
  });

  it("producer-owned metadata keys are cleared by their owner and kept otherwise", () => {
    const s1 = seed(
      {
        outcome: "failed",
        metadata_json: JSON.stringify({
          reason: "error",
          classifier_declined: true,
          decline_reason: "p",
          worker_head_sha: SHA_A,
        }),
      },
      at(1),
    );
    const s2 = m()(
      s1,
      r({
        source: "reconciler",
        outcome: "pr_opened",
        ts: T2,
        metadata_json: JSON.stringify({ pr_url: "u", regression_summary: "s", timed_out: true }),
      }),
      at(1),
    );
    expect(meta(s2)).toMatchObject({
      reason: "error",
      classifier_declined: true,
      pr_url: "u",
      regression_summary: "s",
      timed_out: true,
      producers: { worker: T1, reconciler: T2 },
    });

    const s3 = m()(s2, r({ ts: T3, metadata_json: '{"reason":"completed"}' }), at(1));
    const m3 = meta(s3);
    expect(m3.reason).toBe("completed");
    expect(m3).not.toHaveProperty("classifier_declined");
    expect(m3).not.toHaveProperty("decline_reason");
    expect(m3).not.toHaveProperty("worker_head_sha");
    expect(m3.pr_url).toBe("u");
    expect(m3.regression_summary).toBe("s");
    expect(m3.timed_out).toBe(true);

    const s4 = m()(s3, r({ source: "reconciler", outcome: "merged", ts: T3 }), at(1));
    const m4 = meta(s4);
    expect(m4).not.toHaveProperty("regression_summary");
    expect(m4).not.toHaveProperty("timed_out");
    expect(m4.pr_url).toBe("u");
    expect(m4.reason).toBe("completed");

    const s5 = m()(
      s4,
      r({
        source: "operator",
        outcome: "merged",
        ts: T3,
        metadata_json: '{"source":"operator"}',
      }),
      at(1),
    );
    expect(meta(s5)).toMatchObject({
      pr_url: "u",
      reason: "completed",
      source: "operator",
    });
    expect(meta(s5).producers).toEqual({ worker: T3, reconciler: T3, operator: T3 });
  });

  it("SL classifications are kept within the attempt and reset by a new attempt; gate_outcome is always the stored value", () => {
    const stored = seed(
      {
        reliability_status: "complete",
        maestro_takeover_required: "y",
        failure_class: "context_overflow",
        gate_outcome: "passed",
      },
      at(1),
    );

    const same = m()(
      stored,
      r({ ts: T2, source: "reconciler", outcome: "merged", gate_outcome: "failed" }),
      at(1),
    );
    expect(same.reliability_status).toBe("complete");
    expect(same.maestro_takeover_required).toBe("y");
    expect(same.failure_class).toBe("context_overflow");
    expect(same.gate_outcome).toBe("passed");

    const changed = m()(
      stored,
      r({
        ts: T2,
        reliability_status: "no_worktree_activity",
        maestro_takeover_required: "n",
      }),
      at(1),
    );
    expect(changed.reliability_status).toBe("no_worktree_activity");
    expect(changed.maestro_takeover_required).toBe("n");

    const next = m()(stored, r({ ts: T2, gate_outcome: "failed" }), at(2));
    expect(next.reliability_status).toBeNull();
    expect(next.maestro_takeover_required).toBeNull();
    expect(next.failure_class).toBeNull();
    expect(next.gate_outcome).toBe("passed");
  });

  it("merge is pure and deterministic", () => {
    const stored = seed({ artifact_present: "y", metadata_json: '{"reason":"error"}' }, at(1));
    const incoming = r({
      source: "reconciler",
      outcome: "merged",
      ts: T2,
      metadata_json: JSON.stringify({ pr_url: "u", gone: null }),
    });
    const sc = structuredClone(stored);
    const ic = structuredClone(incoming);
    const o1 = m()(stored, incoming, at(1));
    const o2 = m()(stored, incoming, at(1));

    expect(stored).toEqual(sc);
    expect(incoming).toEqual(ic);
    expect(o1).toEqual(o2);
  });
});
