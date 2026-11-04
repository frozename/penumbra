import { beforeAll, expect, test } from "bun:test";

import { EpisodeSchema } from "@src/evals/manifest.js";

type JsonObject = Record<string, unknown>;

// Input and output shapes are declared locally: aggregate.ts does not exist at
// the base, so no value or type may be imported from it.
type Interval = { lo: number; hi: number };
type SolvedVerifiedReport = {
  s: number;
  n: number;
  n_unknown: number;
  cluster_ci: Interval | null;
};
type FirstAttemptReport = { s: number; n: number; n_unknown: number };
type TokenReport = { sum: number; n_missing: number; n_incomplete: number; complete: boolean };
type GroupReport = {
  n_families: number;
  underpowered: boolean;
  solved_verified: SolvedVerifiedReport;
  first_attempt: FirstAttemptReport;
  failures: Record<string, number>;
  n_excluded: Record<string, number>;
  tokens: TokenReport;
};
type VerifyResultLike =
  | {
      status: "verified";
      verdict: "pass" | "fail";
      fail_reason: string | null;
      sha: string | null;
      control_verdict: string | null;
    }
  | { status: "rejected"; reason: string };
type AggOpts = {
  verifier: unknown;
  resolveFixture: (ref: unknown) => unknown;
  groupBy: string;
  minFamilies: number;
  seed: number;
  B?: number;
};
type AggregateFn = (eps: readonly unknown[], opts: AggOpts) => Promise<{ groups: GroupReport[] }>;

const MOD_URL = new URL("../../src/evals/aggregate.ts", import.meta.url).href;

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

const aggregateEpisodes = (): AggregateFn => mod?.["aggregateEpisodes"] as AggregateFn;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const GRADER_BUILD = "9".repeat(64);

function digest(i: number): string {
  return i.toString(16).padStart(64, "0");
}

function identityUnknown(): JsonObject {
  return { value: null, provenance: "unknown", missing_reason: "x" };
}

function modelIdentity(): JsonObject {
  return {
    requested: identityUnknown(),
    effective: identityUnknown(),
    quant: identityUnknown(),
    engine: identityUnknown(),
    adapter: identityUnknown(),
    config_sha256: null,
    artifact_identity: null,
  };
}

function att(n: number, headSha: string | null): JsonObject {
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
    timings: { queue_ms: null, exec_ms: null, check_ms: null, e2e_ms: null },
    usage: { tokens: null, cost_usd: null, scope: "unknown", missing_reason: "x" },
  };
}

function makeEpisode(overrides: JsonObject = {}): JsonObject {
  const episode: JsonObject = {
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
      status: "complete",
      reason: null,
      count: 1,
      count_basis: "claim_events",
    },
    attempts: [att(1, SHA_A)],
    assistance: [],
    final_sha: SHA_A,
    receipts: [],
    observed_outcome: { class: "terminal_unverified" },
    handoff_reliability: null,
    lineage_usage: null,
    labels: {},
    ...overrides,
  };
  const parsed = EpisodeSchema.safeParse(episode);
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.issues));
  }
  expect(parsed.success).toBe(true);
  return episode;
}

function hiddenReceipt(overrides: {
  digest: string;
  verdict?: "pass" | "fail";
  sha?: string;
}): JsonObject {
  const verdict = overrides.verdict ?? "pass";
  return {
    kind: "hidden_assertion",
    sha: overrides.sha ?? SHA_A,
    producer: "grader",
    claimed_verdict: verdict,
    fail_reason: verdict === "fail" ? "hidden_failed" : null,
    assertion_set_digest: overrides.digest,
    grader_build: GRADER_BUILD,
    per_check: [{ id: "c1", ok: verdict === "pass" }],
    control_verdict: "pass",
    receipt_digest: null,
  };
}

function verifiedResult(
  verdict: "pass" | "fail",
  failReason: string | null,
  sha: string,
): VerifyResultLike {
  return { status: "verified", verdict, fail_reason: failReason, sha, control_verdict: "pass" };
}

type VerifierFn = (
  episode: { episode_id: string },
  claim: { assertion_set_digest: string | null },
) => VerifyResultLike;

function fakeVerifier(table: Map<string, VerifyResultLike | "throw">): VerifierFn {
  return (episode, claim): VerifyResultLike => {
    const key = `${episode.episode_id}:${String(claim.assertion_set_digest)}`;
    const hit = table.get(key);
    if (hit === undefined) {
      return { status: "rejected", reason: "unknown" };
    }
    if (hit === "throw") {
      throw new Error("verifier exploded");
    }
    return hit;
  };
}

function fixtureReturning(value: unknown): () => unknown {
  return (): unknown => value;
}

function envFailure(): JsonObject {
  return {
    class: "environment_failure",
    kind: "environment",
    env_evidence: {
      source: "dispatch_failure_class",
      ref: "evt-1",
      observed_at: "2026-11-01T10:00:00Z",
      first_model_turn_at: null,
    },
  };
}

function usagePresent(tokens: number): JsonObject {
  return {
    tokens,
    cost_usd: null,
    handoff_ids_counted: 1,
    complete: true,
    incomplete_reason: null,
  };
}

function usageMissing(): JsonObject {
  return {
    tokens: null,
    cost_usd: null,
    handoff_ids_counted: 1,
    complete: false,
    incomplete_reason: "handoff_usage_missing",
  };
}

function blockedEpisode(id: string): JsonObject {
  const family = `fam-${id}`;
  return makeEpisode({
    episode_id: id,
    family_id: family,
    fixture_ref: { family_id: family, variant_id: "v1" },
    observed_outcome: { class: "blocked_correct", expectation_ref: "exp-1" },
  });
}

function aggOpts(overrides: Partial<AggOpts> = {}): AggOpts {
  return {
    verifier: fakeVerifier(new Map()),
    resolveFixture: fixtureReturning(null),
    groupBy: "split",
    minFamilies: 1,
    seed: 7,
    B: 200,
    ...overrides,
  };
}

function runAgg(
  eps: readonly JsonObject[],
  overrides: Partial<AggOpts> = {},
): Promise<{ groups: GroupReport[] }> {
  return aggregateEpisodes()(eps, aggOpts(overrides));
}

test("P5-5: verified passes aggregate into one group with family counts", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const eps: JsonObject[] = [];
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const d = digest(i);
    eps.push(
      makeEpisode({
        episode_id: `e${String(i)}`,
        family_id: `fam-${String(i)}`,
        attempts: [att(1, SHA_A), att(2, SHA_B), att(3, SHA_C)],
        attempt_history: {
          status: "complete",
          reason: null,
          count: 3,
          count_basis: "claim_events",
        },
        final_sha: SHA_C,
        receipts: [hiddenReceipt({ digest: d, sha: SHA_C })],
      }),
    );
    table.set(`e${String(i)}:${d}`, verifiedResult("pass", null, SHA_C));
  }
  const res = await runAgg(eps, { verifier: fakeVerifier(table) });
  expect(res.groups).toHaveLength(1);
  expect(res.groups[0]?.n_families).toBe(10);
  expect(res.groups[0]?.solved_verified.s).toBe(10);
  expect(res.groups[0]?.solved_verified.n).toBe(10);
});

test("P5-6a: a rejected verification stays unknown even when the claim says pass", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const d = digest(1);
  const ep = makeEpisode({ receipts: [hiddenReceipt({ digest: d })] });
  const res = await runAgg([ep], { verifier: fakeVerifier(new Map()) });
  expect(res.groups[0]?.solved_verified.s).toBe(0);
  expect(res.groups[0]?.solved_verified.n_unknown).toBe(1);
});

test("P5-6b: a throwing verifier stays unknown and claimed_verdict is never read", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const d = digest(1);
  const ep = makeEpisode({ receipts: [hiddenReceipt({ digest: d })] });
  const receipt = (ep.receipts as JsonObject[])[0]!;
  let read = false;
  Object.defineProperty(receipt, "claimed_verdict", {
    configurable: true,
    enumerable: true,
    get(): string {
      read = true;
      return "pass";
    },
  });
  const table = new Map<string, VerifyResultLike | "throw">([[`e1:${d}`, "throw"]]);
  const res = await runAgg([ep], { verifier: fakeVerifier(table) });
  expect(read).toBe(false);
  expect(res.groups[0]?.solved_verified.s).toBe(0);
});

test("P5-7: a verified failure lands in the failure histogram by fail_reason", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const d = digest(1);
  const ep = makeEpisode({ receipts: [hiddenReceipt({ digest: d })] });
  const table = new Map<string, VerifyResultLike | "throw">([
    [`e1:${d}`, verifiedResult("fail", "candidate_timeout", SHA_A)],
  ]);
  const res = await runAgg([ep], { verifier: fakeVerifier(table) });
  const g = res.groups[0];
  expect(g?.solved_verified.n).toBe(1);
  expect(g?.solved_verified.s).toBe(0);
  expect(g?.failures.candidate_timeout).toBe(1);
});

test("P5-8: an unverified environment failure is excluded from the denominator", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const ep = makeEpisode({ observed_outcome: envFailure() });
  const res = await runAgg([ep]);
  const g = res.groups[0];
  expect(g?.solved_verified.n).toBe(0);
  expect(g?.n_excluded.environment).toBe(1);
  expect(g?.solved_verified.n_unknown).toBe(0);
});

test("P5-9: groupBy is restricted to declared dimensions", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const eps = [
    makeEpisode({ episode_id: "e-a", family_id: "fam-a" }),
    makeEpisode({ episode_id: "e-b", family_id: "fam-b" }),
  ];
  for (const groupBy of ["recipe_id", "failure_type", "split"]) {
    const res = await runAgg(eps, { groupBy });
    expect(res.groups.length).toBeGreaterThan(0);
  }
  let threw = false;
  try {
    await runAgg(eps, { groupBy: "agent_name" });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test("P5-10: lineage token usage aggregates with honest missingness", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const eps = [
    makeEpisode({ episode_id: "e-t1", family_id: "fam-t1", lineage_usage: usagePresent(100) }),
    makeEpisode({ episode_id: "e-t2", family_id: "fam-t2", lineage_usage: usageMissing() }),
    makeEpisode({ episode_id: "e-t3", family_id: "fam-t3", lineage_usage: usagePresent(50) }),
  ];
  const res = await runAgg(eps);
  expect(res.groups[0]?.tokens).toEqual({
    sum: 150,
    n_missing: 1,
    n_incomplete: 0,
    complete: false,
  });
});

test("P5-11a: observed model failures count toward the denominator", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const d1 = digest(1);
  const d2 = digest(2);
  const eps = [
    makeEpisode({
      episode_id: "e-1",
      family_id: "fam-1",
      receipts: [hiddenReceipt({ digest: d1 })],
    }),
    makeEpisode({
      episode_id: "e-2",
      family_id: "fam-2",
      receipts: [hiddenReceipt({ digest: d2 })],
    }),
    makeEpisode({
      episode_id: "e-3",
      family_id: "fam-3",
      observed_outcome: { class: "model_failure", reason: "hidden_failed" },
    }),
    makeEpisode({
      episode_id: "e-4",
      family_id: "fam-4",
      observed_outcome: { class: "model_failure", reason: "incorrect_blocked" },
    }),
  ];
  const table = new Map<string, VerifyResultLike | "throw">([
    [`e-1:${d1}`, verifiedResult("pass", null, SHA_A)],
    [`e-2:${d2}`, verifiedResult("pass", null, SHA_A)],
  ]);
  const res = await runAgg(eps, { verifier: fakeVerifier(table) });
  expect(res.groups[0]?.solved_verified.s).toBe(2);
  expect(res.groups[0]?.solved_verified.n).toBe(4);
});

test("P5-11b: a fixture-confirmed blocked_correct is excluded from the denominator", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const d1 = digest(1);
  const d2 = digest(2);
  const eps = [
    makeEpisode({
      episode_id: "e-1",
      family_id: "fam-1",
      receipts: [hiddenReceipt({ digest: d1 })],
    }),
    makeEpisode({
      episode_id: "e-2",
      family_id: "fam-2",
      receipts: [hiddenReceipt({ digest: d2 })],
    }),
    makeEpisode({
      episode_id: "e-3",
      family_id: "fam-3",
      observed_outcome: { class: "model_failure", reason: "hidden_failed" },
    }),
    blockedEpisode("e-4"),
  ];
  const table = new Map<string, VerifyResultLike | "throw">([
    [`e-1:${d1}`, verifiedResult("pass", null, SHA_A)],
    [`e-2:${d2}`, verifiedResult("pass", null, SHA_A)],
  ]);
  const res = await runAgg(eps, {
    verifier: fakeVerifier(table),
    resolveFixture: fixtureReturning({ expect_blocked: true }),
  });
  const g = res.groups[0];
  expect(g?.solved_verified.s).toBe(2);
  expect(g?.solved_verified.n).toBe(3);
  expect(g?.n_excluded.blocked_correct).toBe(1);
});

test("P5-12: a partial attempt history makes first-attempt eligibility unknown", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const d = digest(1);
  const ep = makeEpisode({
    attempts: [att(2, SHA_A)],
    attempt_history: {
      status: "partial",
      reason: "claims_pruned",
      count: 2,
      count_basis: "handoff_counter",
    },
    receipts: [hiddenReceipt({ digest: d })],
  });
  const table = new Map<string, VerifyResultLike | "throw">([
    [`e1:${d}`, verifiedResult("pass", null, SHA_A)],
  ]);
  const res = await runAgg([ep], { verifier: fakeVerifier(table) });
  const g = res.groups[0];
  expect(g?.solved_verified.s).toBe(1);
  expect(g?.first_attempt.s).toBe(0);
  expect(g?.first_attempt.n_unknown).toBe(1);
});

test("P5-13: a verified failure overrides the observed environment failure", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const d = digest(1);
  const ep = makeEpisode({
    observed_outcome: envFailure(),
    receipts: [hiddenReceipt({ digest: d })],
  });
  const table = new Map<string, VerifyResultLike | "throw">([
    [`e1:${d}`, verifiedResult("fail", "hidden_failed", SHA_A)],
  ]);
  const res = await runAgg([ep], { verifier: fakeVerifier(table) });
  const g = res.groups[0];
  expect(g?.solved_verified.n).toBe(1);
  expect(g?.n_excluded.environment).toBe(0);
  expect(g?.failures.hidden_failed).toBe(1);
});

test("P5-14: blocked_correct is a failure when the fixture does not expect a block", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = await runAgg([blockedEpisode("e-b1")], {
    resolveFixture: fixtureReturning({ expect_blocked: false }),
  });
  const g = res.groups[0];
  expect(g?.solved_verified.n).toBe(1);
  expect(g?.failures.incorrect_blocked).toBe(1);
});

test("P5-14: blocked_correct is a failure when the fixture cannot be resolved", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = await runAgg([blockedEpisode("e-b2")], {
    resolveFixture: fixtureReturning(null),
  });
  const g = res.groups[0];
  expect(g?.solved_verified.n).toBe(1);
  expect(g?.failures.incorrect_blocked).toBe(1);
});

test("P5-14: blocked_correct is excluded when the fixture expects a block", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = await runAgg([blockedEpisode("e-b3")], {
    resolveFixture: fixtureReturning({ expect_blocked: true }),
  });
  const g = res.groups[0];
  expect(g?.solved_verified.n).toBe(0);
  expect(g?.n_excluded.blocked_correct).toBe(1);
});

test("P5-15: a verifier-reported nondeterministic lands in failures", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const d = digest(1);
  const ep = makeEpisode({ receipts: [hiddenReceipt({ digest: d })] });
  const table = new Map<string, VerifyResultLike | "throw">([
    [`e1:${d}`, verifiedResult("fail", "nondeterministic", SHA_A)],
  ]);
  const res = await runAgg([ep], { verifier: fakeVerifier(table) });
  const g = res.groups[0];
  expect(g?.solved_verified.n).toBe(1);
  expect(g?.solved_verified.n_unknown).toBe(0);
  expect(g?.failures.nondeterministic).toBe(1);
});

test("P5-16: disagreeing assertion sets resolve to nondeterministic", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const d1 = digest(1);
  const d2 = digest(2);
  const ep = makeEpisode({
    receipts: [hiddenReceipt({ digest: d1 }), hiddenReceipt({ digest: d2 })],
  });
  const table = new Map<string, VerifyResultLike | "throw">([
    [`e1:${d1}`, verifiedResult("pass", null, SHA_A)],
    [`e1:${d2}`, verifiedResult("fail", "hidden_failed", SHA_A)],
  ]);
  const res = await runAgg([ep], { verifier: fakeVerifier(table) });
  const g = res.groups[0];
  expect(g?.solved_verified.s).toBe(0);
  expect(g?.solved_verified.n).toBe(1);
  expect(g?.failures.nondeterministic).toBe(1);
});

test("P5-17: underpowered groups suppress the cluster interval", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const mkPass = (id: string, i: number): JsonObject => {
    const d = digest(i);
    table.set(`${id}:${d}`, verifiedResult("pass", null, SHA_A));
    return makeEpisode({
      episode_id: id,
      family_id: `fam-${id}`,
      receipts: [hiddenReceipt({ digest: d })],
    });
  };
  const two = [mkPass("e-p1", 21), mkPass("e-p2", 22)];
  const under = await runAgg(two, { verifier: fakeVerifier(table), minFamilies: 3 });
  expect(under.groups[0]?.underpowered).toBe(true);
  expect(under.groups[0]?.solved_verified.cluster_ci).toBeNull();
  const three = [...two, mkPass("e-p3", 23)];
  const powered = await runAgg(three, { verifier: fakeVerifier(table), minFamilies: 3 });
  expect(powered.groups[0]?.underpowered).toBe(false);
  expect(powered.groups[0]?.solved_verified.cluster_ci).not.toBeNull();
});

test("P5-18: the first failing receipt in order supplies the fail_reason", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const d1 = digest(1);
  const d2 = digest(2);
  const ep = makeEpisode({
    receipts: [hiddenReceipt({ digest: d1 }), hiddenReceipt({ digest: d2 })],
  });
  const table = new Map<string, VerifyResultLike | "throw">([
    [`e1:${d1}`, verifiedResult("fail", "candidate_timeout", SHA_A)],
    [`e1:${d2}`, verifiedResult("fail", "hidden_failed", SHA_A)],
  ]);
  const res = await runAgg([ep], { verifier: fakeVerifier(table) });
  expect(res.groups[0]?.failures.candidate_timeout).toBe(1);
  expect(res.groups[0]?.failures.hidden_failed).toBe(0);
});
