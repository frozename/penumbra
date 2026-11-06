import { beforeAll, expect, test } from "bun:test";

import { AttemptSchema, EpisodeSchema, ModelIdentitySchema } from "@src/evals/manifest.js";

type JsonObject = Record<string, unknown>;

// Input and output shapes are declared locally: attempts.ts does not exist at
// the base, so no value or type may be imported from it.
type EventRow = {
  id: number;
  handoff_id: string;
  worker_id: string | null;
  source: "daemon" | "worker";
  kind: string;
  ts: string;
  meta_json: string | null;
};

type HandoffLike = { handoff_id: string; ts: string; dispatch_attempts: number };

type SliceOpts = { now: number; retentionDays: number; startN: number };

type AttemptCommits = {
  final_commit_attribution: "model" | "recovery" | "unknown";
  attribution_basis: "dispatch_end_autocommitted" | "controlled_harness_build" | "none";
  autocommit_flag: true | null;
};

type ContractFlags = {
  scope: "attempt";
  source: "attempt_dispatch_end" | "grader" | "none";
  base_not_ancestor: boolean | null;
  identity_mismatch: boolean | null;
};

type SlicedAttempt = {
  n: number;
  handoff_id: string;
  dispatch_attempt: number | null;
  head_sha: string | null;
  commits: AttemptCommits;
  contract_flags: ContractFlags;
  timings: {
    queue_ms: number | null;
    exec_ms: number | null;
    check_ms: number | null;
    e2e_ms: number | null;
  };
  usage: {
    tokens: number | null;
    cost_usd: number | null;
    scope: "attempt" | "unknown";
    missing_reason?: string;
  };
};

type EffectiveModel = { value: string | null; provenance: string; missing_reason?: string };

type AttemptSlice = {
  attempt: SlicedAttempt;
  effective_model: EffectiveModel;
  tool_failure_count: number;
};

type SliceHistory = {
  status: "complete" | "partial" | "unavailable";
  reason: "retention_window" | "events_absent" | "claims_pruned" | null;
  count: number | null;
  count_basis:
    | "claim_events"
    | "handoff_counter"
    | "handoff_counter_lower_bound"
    | "fixture_replay"
    | "unknown";
};

type SliceResult = {
  history: SliceHistory;
  attempts: AttemptSlice[];
  orphan_events_dropped: number;
};

type SliceFn = (handoff: HandoffLike, events: EventRow[], opts: SliceOpts) => SliceResult;
type EligibilityFn = (episode: JsonObject) => "eligible" | "ineligible" | "unknown";

const MOD_URL = new URL("../../src/evals/attempts.ts", import.meta.url).href;

async function load(): Promise<Record<string, unknown> | null> {
  try {
    return (await import(MOD_URL)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let mod: Record<string, unknown> | null = null;

beforeAll(async () => {
  mod = await load();
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

const NOW = Date.parse("2026-11-03T00:00:00Z");
const TS_1D = "2026-11-02T00:00:00Z";
const TS_2D = "2026-11-01T00:00:00Z";
const TS_20D = "2026-10-14T00:00:00Z";
const TS_30D = "2026-10-04T00:00:00Z";

function handoff(ts: string, dispatchAttempts: number): HandoffLike {
  return { handoff_id: "h1", ts, dispatch_attempts: dispatchAttempts };
}

function opts(startN = 1): SliceOpts {
  return { now: NOW, retentionDays: 14, startN };
}

function evTs(id: number): string {
  return new Date(Date.parse(TS_1D) + id * 1000).toISOString();
}

function ev(id: number, kind: string, meta?: JsonObject): EventRow {
  return {
    id,
    handoff_id: "h1",
    worker_id: null,
    source: "worker",
    kind,
    ts: evTs(id),
    meta_json: meta === undefined ? null : JSON.stringify(meta),
  };
}

function integrity(headSha: string, overrides: JsonObject = {}): JsonObject {
  return {
    base_sha: SHA_A,
    head_sha: headSha,
    base_is_ancestor: true,
    identity: { name: "Worker", email: "worker@example.com" },
    mismatched_commits: [],
    mismatched_total: 0,
    ...overrides,
  };
}

function dispatchEndMeta(headSha: string, overrides: JsonObject = {}): JsonObject {
  return { commit_integrity: integrity(headSha), ...overrides };
}

// Episode builders copied from packages/core/test/evals/manifest.test.ts so a
// sliced result can be wrapped in a schema-valid episode.
function identityUnknown(): JsonObject {
  return { value: null, provenance: "unknown", missing_reason: "x" };
}

function modelIdentity(overrides: JsonObject = {}): JsonObject {
  return {
    requested: identityUnknown(),
    effective: identityUnknown(),
    quant: identityUnknown(),
    engine: identityUnknown(),
    adapter: identityUnknown(),
    config_sha256: null,
    artifact_identity: null,
    ...overrides,
  };
}

function ep(overrides: JsonObject = {}): JsonObject {
  return {
    schema_version: 1,
    episode_id: "e1",
    family_id: "fam-h-t000000000000",
    fixture_ref: null,
    split: "dev",
    design: "observational",
    failure_type: null,
    task_digest: null,
    task_refs: { issues: [], bundle_ids: [] },
    repo: { base_sha: null, dependency_lock_sha256: null },
    recipe_id: null,
    model_identity: modelIdentity(),
    harness_build: { sha: null, missing_reason: "x" },
    environment: { worktree_kind: null, os: null, bun_version: null },
    lineage: { root_handoff_id: null, handoff_ids: [], shape: "single" },
    attempt_history: {
      status: "unavailable",
      reason: "events_absent",
      count: null,
      count_basis: "unknown",
    },
    attempts: [],
    assistance: [],
    final_sha: null,
    receipts: [],
    observed_outcome: { class: "unknown", missing_reason: "x" },
    handoff_reliability: null,
    lineage_usage: null,
    labels: {},
    ...overrides,
  };
}

function attTimings(): JsonObject {
  return { queue_ms: null, exec_ms: null, check_ms: null, e2e_ms: null };
}

function att(n: number, headSha: string | null, overrides: JsonObject = {}): JsonObject {
  return {
    n,
    handoff_id: `h${String(n)}`,
    dispatch_attempt: null,
    head_sha: headSha,
    commits: {
      final_commit_attribution: "unknown",
      attribution_basis: "none",
      autocommit_flag: null,
    },
    contract_flags: {
      scope: "attempt",
      source: "none",
      base_not_ancestor: null,
      identity_mismatch: null,
    },
    timings: attTimings(),
    usage: { tokens: null, cost_usd: null, scope: "unknown", missing_reason: "x" },
    ...overrides,
  };
}

function history(
  status: string,
  reason: string | null,
  count: number | null,
  countBasis: string,
): JsonObject {
  return { status, reason, count, count_basis: countBasis };
}

function episodeFrom(result: SliceResult): JsonObject {
  return ep({
    attempt_history: result.history,
    attempts: result.attempts.map((entry) => entry.attempt),
    assistance: [],
    final_sha: result.attempts.at(-1)?.attempt.head_sha ?? null,
  });
}

function sliceFn(): SliceFn {
  return mod?.["sliceHandoffAttempts"] as SliceFn;
}

function eligibilityFn(): EligibilityFn {
  return mod?.["firstAttemptEligibility"] as EligibilityFn;
}

test("R1: claim boundaries isolate each attempt's dispatch.end, autocommit and tool failures", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 2),
    [
      ev(1, "claim"),
      ev(2, "agent.tool_call.failed", { failure_kind: "error" }),
      ev(3, "dispatch.end", {
        autocommitted: true,
        autocommit_sha: SHA_A,
        commit_integrity: integrity(SHA_C),
      }),
      ev(4, "claim"),
      ev(5, "dispatch.end", dispatchEndMeta(SHA_B)),
    ],
    opts(),
  );
  expect(result.history).toEqual({
    status: "complete",
    reason: null,
    count: 2,
    count_basis: "claim_events",
  });
  expect(result.orphan_events_dropped).toBe(0);
  expect(result.attempts).toHaveLength(2);
  const first = result.attempts[0];
  const second = result.attempts[1];
  expect(first?.attempt.head_sha).toBe(SHA_A);
  expect(first?.attempt.commits).toEqual({
    final_commit_attribution: "recovery",
    attribution_basis: "dispatch_end_autocommitted",
    autocommit_flag: true,
  });
  expect(first?.tool_failure_count).toBe(1);
  expect(second?.attempt.head_sha).toBe(SHA_B);
  expect(second?.attempt.commits).toEqual({
    final_commit_attribution: "unknown",
    attribution_basis: "none",
    autocommit_flag: null,
  });
  expect(second?.tool_failure_count).toBe(0);
  for (const entry of result.attempts) {
    expect(AttemptSchema.safeParse(entry.attempt).success).toBe(true);
  }
});

test("R2a: an autocommitted dispatch.end resolves head to the autocommit sha", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "dispatch.end", {
        autocommitted: true,
        autocommit_sha: SHA_A,
        commit_integrity: integrity(SHA_B),
      }),
    ],
    opts(),
  );
  expect(result.attempts[0]?.attempt.head_sha).toBe(SHA_A);
});

test("R2b: without autocommit, head falls back to commit_integrity.head_sha", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 1),
    [ev(1, "claim"), ev(2, "dispatch.end", dispatchEndMeta(SHA_B))],
    opts(),
  );
  expect(result.attempts[0]?.attempt.head_sha).toBe(SHA_B);
});

test("R3a: contract flags come from each attempt's own dispatch.end", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 2),
    [
      ev(1, "claim"),
      ev(2, "dispatch.end", {
        commit_integrity: integrity(SHA_B, {
          base_is_ancestor: false,
          mismatched_total: null,
        }),
      }),
      ev(3, "claim"),
      ev(4, "dispatch.end", dispatchEndMeta(SHA_C)),
    ],
    opts(),
  );
  expect(result.attempts.map((entry) => entry.attempt.contract_flags.base_not_ancestor)).toEqual([
    true,
    false,
  ]);
  expect(result.attempts.map((entry) => entry.attempt.contract_flags.source)).toEqual([
    "attempt_dispatch_end",
    "attempt_dispatch_end",
  ]);
});

test("R3b: a null mismatched_total gives a null identity_mismatch", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "dispatch.end", { commit_integrity: integrity(SHA_B, { mismatched_total: null }) }),
    ],
    opts(),
  );
  const flags = result.attempts[0]?.attempt.contract_flags;
  expect(flags?.source).toBe("attempt_dispatch_end");
  expect(flags?.identity_mismatch).toBeNull();
});

test("R3c: invalid commit_integrity gives null flags with source none", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 1),
    [ev(1, "claim"), ev(2, "dispatch.end", { commit_integrity: integrity("zz") })],
    opts(),
  );
  const flags = result.attempts[0]?.attempt.contract_flags;
  expect(flags?.source).toBe("none");
  expect(flags?.base_not_ancestor).toBeNull();
  expect(flags?.identity_mismatch).toBeNull();
  expect(result.attempts[0]?.attempt.head_sha).toBeNull();
});

test("R3d: identity_mismatch reads mismatched_total as strictly greater than zero", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const nonzero = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "dispatch.end", { commit_integrity: integrity(SHA_B, { mismatched_total: 2 }) }),
    ],
    opts(),
  );
  expect(nonzero.attempts[0]?.attempt.contract_flags.identity_mismatch).toBe(true);
  const zero = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "dispatch.end", { commit_integrity: integrity(SHA_B, { mismatched_total: 0 }) }),
    ],
    opts(),
  );
  expect(zero.attempts[0]?.attempt.contract_flags.identity_mismatch).toBe(false);
});

test("R3e: absent mismatched_total falls back to the mismatched_commits list", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const nonEmpty = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "dispatch.end", {
        commit_integrity: integrity(SHA_B, {
          mismatched_commits: [SHA_B],
          mismatched_total: undefined,
        }),
      }),
    ],
    opts(),
  );
  expect(nonEmpty.attempts[0]?.attempt.contract_flags.source).toBe("attempt_dispatch_end");
  expect(nonEmpty.attempts[0]?.attempt.contract_flags.identity_mismatch).toBe(true);
  const empty = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "dispatch.end", {
        commit_integrity: integrity(SHA_B, {
          mismatched_commits: [],
          mismatched_total: undefined,
        }),
      }),
    ],
    opts(),
  );
  expect(empty.attempts[0]?.attempt.contract_flags.identity_mismatch).toBe(false);
});

test("R3f: within one attempt the last dispatch.end wins for head and flags", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "dispatch.end", {
        autocommitted: true,
        autocommit_sha: SHA_A,
        commit_integrity: integrity(SHA_C, {
          base_is_ancestor: false,
          mismatched_total: 3,
        }),
      }),
      ev(3, "dispatch.end", dispatchEndMeta(SHA_B)),
    ],
    opts(),
  );
  const attempt = result.attempts[0]?.attempt;
  expect(attempt?.head_sha).toBe(SHA_B);
  expect(attempt?.commits).toEqual({
    final_commit_attribution: "unknown",
    attribution_basis: "none",
    autocommit_flag: null,
  });
  expect(attempt?.contract_flags.base_not_ancestor).toBe(false);
  expect(attempt?.contract_flags.identity_mismatch).toBe(false);
});

test("R4: only autocommitted === true marks the commit a recovery", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const unknownAttribution = {
    final_commit_attribution: "unknown",
    attribution_basis: "none",
    autocommit_flag: null,
  } as const;
  const withoutKey = sliceFn()(
    handoff(TS_1D, 1),
    [ev(1, "claim"), ev(2, "dispatch.end", dispatchEndMeta(SHA_B))],
    opts(),
  );
  expect(withoutKey.attempts[0]?.attempt.commits).toEqual(unknownAttribution);
  const explicitFalse = sliceFn()(
    handoff(TS_1D, 1),
    [ev(1, "claim"), ev(2, "dispatch.end", dispatchEndMeta(SHA_B, { autocommitted: false }))],
    opts(),
  );
  expect(explicitFalse.attempts[0]?.attempt.commits).toEqual(unknownAttribution);
});

test("R5a: acp.model_unavailable leaves the effective model unattested", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "acp.model_unavailable", { model: "qwen", advertised: false }),
      ev(3, "dispatch.end", dispatchEndMeta(SHA_B)),
    ],
    opts(),
  );
  const effective = result.attempts[0]?.effective_model;
  expect(effective?.value).toBeNull();
  expect(effective?.value).not.toBe("qwen");
  expect(effective?.provenance).toBe("unattested");
  expect(ModelIdentitySchema.shape.effective.safeParse(effective).success).toBe(true);
});

test("R5b: acp.model_select_failed leaves the effective model unattested", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "acp.model_select_failed", { model: "qwen", error: "rejected" }),
      ev(3, "dispatch.end", dispatchEndMeta(SHA_B)),
    ],
    opts(),
  );
  const effective = result.attempts[0]?.effective_model;
  expect(effective?.value).toBeNull();
  expect(effective?.value).not.toBe("qwen");
  expect(effective?.provenance).toBe("unattested");
  expect(ModelIdentitySchema.shape.effective.safeParse(effective).success).toBe(true);
});

test("R5c: with no acp model event the effective model is unknown", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 1),
    [ev(1, "claim"), ev(2, "dispatch.end", dispatchEndMeta(SHA_B))],
    opts(),
  );
  const effective = result.attempts[0]?.effective_model;
  expect(effective?.value).toBeNull();
  expect(effective?.provenance).toBe("unknown");
  expect(ModelIdentitySchema.shape.effective.safeParse(effective).success).toBe(true);
});

test("R5d: acp.model_selected attests the model, set_model_sent picks the provenance", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const selected = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "acp.model_selected", { model: "m", set_model_sent: true }),
      ev(3, "dispatch.end", dispatchEndMeta(SHA_B)),
    ],
    opts(),
  );
  expect(selected.attempts[0]?.effective_model).toMatchObject({
    value: "m",
    provenance: "acp_selected",
  });
  expect(
    ModelIdentitySchema.shape.effective.safeParse(selected.attempts[0]?.effective_model).success,
  ).toBe(true);
  const current = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "acp.model_selected", { model: "m", set_model_sent: false }),
      ev(3, "dispatch.end", dispatchEndMeta(SHA_B)),
    ],
    opts(),
  );
  expect(current.attempts[0]?.effective_model).toMatchObject({
    value: "m",
    provenance: "acp_current",
  });
  expect(
    ModelIdentitySchema.shape.effective.safeParse(current.attempts[0]?.effective_model).success,
  ).toBe(true);
});

test("R5e: the last acp model event wins - select_failed then selected attests", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "acp.model_select_failed", { model: "qwen", error: "rejected" }),
      ev(3, "acp.model_selected", { model: "m", set_model_sent: true }),
      ev(4, "dispatch.end", dispatchEndMeta(SHA_B)),
    ],
    opts(),
  );
  const effective = result.attempts[0]?.effective_model;
  expect(effective).toMatchObject({ value: "m", provenance: "acp_selected" });
  expect(ModelIdentitySchema.shape.effective.safeParse(effective).success).toBe(true);
});

test("R5f: the last acp model event wins - selected then unavailable de-attests", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 1),
    [
      ev(1, "claim"),
      ev(2, "acp.model_selected", { model: "m", set_model_sent: true }),
      ev(3, "acp.model_unavailable", { model: "m", advertised: false }),
      ev(4, "dispatch.end", dispatchEndMeta(SHA_B)),
    ],
    opts(),
  );
  const effective = result.attempts[0]?.effective_model;
  expect(effective?.value).toBeNull();
  expect(effective?.provenance).toBe("unattested");
  expect(ModelIdentitySchema.shape.effective.safeParse(effective).success).toBe(true);
});

test("R6a: an old handoff with pruned events is unavailable inside the retention window", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(handoff(TS_20D, 2), [], opts());
  expect(result.history).toEqual({
    status: "unavailable",
    reason: "retention_window",
    count: 2,
    count_basis: "handoff_counter_lower_bound",
  });
  expect(result.attempts).toEqual([]);
  expect(result.orphan_events_dropped).toBe(0);
});

test("R6b: without a counter the pruned history count is unknown", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(handoff(TS_20D, 0), [], opts());
  expect(result.history).toEqual({
    status: "unavailable",
    reason: "retention_window",
    count: null,
    count_basis: "unknown",
  });
  expect(result.attempts).toEqual([]);
});

test("R7: a young handoff with no events reports events_absent", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(handoff(TS_2D, 0), [], opts());
  expect(result.history).toEqual({
    status: "unavailable",
    reason: "events_absent",
    count: null,
    count_basis: "unknown",
  });
  expect(result.attempts).toEqual([]);
});

test("R8: pruned claims give a partial history numbered from the handoff counter", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 2),
    [ev(1, "dispatch.start"), ev(2, "claim"), ev(3, "dispatch.end", dispatchEndMeta(SHA_B))],
    opts(),
  );
  expect(result.history).toEqual({
    status: "partial",
    reason: "claims_pruned",
    count: 2,
    count_basis: "handoff_counter",
  });
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0]?.attempt.n).toBe(2);
  expect(result.orphan_events_dropped).toBe(1);
  const episode = episodeFrom(result);
  expect(EpisodeSchema.safeParse(episode).success).toBe(true);
  expect(typeof mod?.["firstAttemptEligibility"]).toBe("function");
  expect(eligibilityFn()(episode)).toBe("unknown");
});

test("R9: surviving claims with a pruned counter and an old handoff are unavailable", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_30D, 0),
    [ev(1, "claim"), ev(2, "dispatch.end", dispatchEndMeta(SHA_B))],
    opts(),
  );
  expect(result.history).toEqual({
    status: "unavailable",
    reason: "claims_pruned",
    count: null,
    count_basis: "unknown",
  });
  expect(result.attempts).toEqual([]);
});

test("R10a: a complete single-attempt episode is eligible for first-attempt eval", () => {
  expect(typeof mod?.["firstAttemptEligibility"]).toBe("function");
  const episode = ep({
    attempt_history: history("complete", null, 1, "claim_events"),
    attempts: [att(1, SHA_A)],
    final_sha: SHA_A,
  });
  expect(eligibilityFn()(episode)).toBe("eligible");
});

test("R10a2: a complete history with zero attempts is unknown, not eligible", () => {
  expect(typeof mod?.["firstAttemptEligibility"]).toBe("function");
  const episode = ep({
    attempt_history: history("complete", null, 0, "claim_events"),
    attempts: [],
  });
  expect(eligibilityFn()(episode)).toBe("unknown");
});

test("R10b: more than one attempt makes the episode ineligible", () => {
  expect(typeof mod?.["firstAttemptEligibility"]).toBe("function");
  const episode = ep({
    attempt_history: history("complete", null, 2, "claim_events"),
    attempts: [att(1, SHA_A), att(2, SHA_B)],
    final_sha: SHA_B,
  });
  expect(eligibilityFn()(episode)).toBe("ineligible");
});

test("R10c: any assistance entry makes the episode ineligible", () => {
  expect(typeof mod?.["firstAttemptEligibility"]).toBe("function");
  const episode = ep({
    attempt_history: history("complete", null, 1, "claim_events"),
    attempts: [att(1, SHA_A)],
    assistance: [{ kind: "fix_round", attempt_n: 1, ref: null }],
    final_sha: SHA_A,
  });
  expect(eligibilityFn()(episode)).toBe("ineligible");
});

test("R10d: a branching lineage makes eligibility unknown", () => {
  expect(typeof mod?.["firstAttemptEligibility"]).toBe("function");
  const episode = ep({
    lineage: { root_handoff_id: null, handoff_ids: ["h1", "h2"], shape: "branching" },
    attempt_history: history("complete", null, 1, "claim_events"),
    attempts: [att(1, SHA_A)],
    final_sha: SHA_A,
  });
  expect(eligibilityFn()(episode)).toBe("unknown");
});

test("R11: complete attempts number from startN, and only 1 is schema-valid", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const events = [
    ev(1, "claim"),
    ev(2, "dispatch.end", dispatchEndMeta(SHA_A)),
    ev(3, "claim"),
    ev(4, "dispatch.end", dispatchEndMeta(SHA_B)),
  ];
  const fromOne = sliceFn()(handoff(TS_1D, 2), events, opts(1));
  expect(fromOne.history).toEqual({
    status: "complete",
    reason: null,
    count: 2,
    count_basis: "claim_events",
  });
  expect(fromOne.attempts.map((entry) => entry.attempt.n)).toEqual([1, 2]);
  expect(EpisodeSchema.safeParse(episodeFrom(fromOne)).success).toBe(true);
  const fromTwo = sliceFn()(handoff(TS_1D, 2), events, opts(2));
  expect(fromTwo.attempts.map((entry) => entry.attempt.n)).toEqual([2, 3]);
  expect(fromTwo.history.count).toBe(2);
  expect(EpisodeSchema.safeParse(episodeFrom(fromTwo)).success).toBe(false);
});

test("R12: a pruned handoff mid-lineage numbers survivors from startN, not from 1", () => {
  expect(typeof mod?.["sliceHandoffAttempts"]).toBe("function");
  const result = sliceFn()(
    handoff(TS_1D, 3),
    [ev(1, "claim"), ev(2, "dispatch.end", dispatchEndMeta(SHA_B))],
    opts(2),
  );
  expect(result.history).toEqual({
    status: "partial",
    reason: "claims_pruned",
    count: 3,
    count_basis: "handoff_counter",
  });
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0]?.attempt.n).toBe(4);
});
