import { beforeAll, expect, test } from "bun:test";

import { computeLockDigest, unsealHoldout, verifyHoldoutLock } from "@src/evals/holdout.js";
import { EpisodeSchema, RecipeSchema } from "@src/evals/manifest.js";

type JsonObject = Record<string, unknown>;

// Input and output shapes are declared locally: capsule-uplift.ts does not
// exist at the base, so no value or type may be imported from it.
type Interval = { lo: number; hi: number };
type Exclusion = { episode_id: string; reason: string };
type ArmReport = {
  s: number;
  n: number;
  n_unknown: number;
  n_excluded: number;
  n_episodes: number;
  rate: number | null;
  wilson: Interval | null;
  cluster_ci: Interval | null;
  tool_permission_errors: number;
  environment_failures: number;
  tool_error_rate: number | null;
};
type ComparisonReport = {
  n_pairs: number;
  n_families: number;
  underpowered: boolean;
  holdout: string;
  baseline: ArmReport;
  treatment: ArmReport;
  discordant: { baseline_only: number; treatment_only: number };
  excluded: Exclusion[];
};
type ContextTokens = { sum: number; median_per_episode: number; n_missing: number };
type CostReport = {
  baseline: { context_tokens: ContextTokens };
  treatment: { context_tokens: ContextTokens };
  context_token_delta: number;
  tool_error_rate_delta: number;
};
type MeasuredReport = {
  status: "measured";
  design: string;
  split: string;
  held_out: boolean;
  evidence: string;
  baseline_recipe_id: string;
  treatment_recipe_id: string;
  verdict: string;
  comparison: ComparisonReport;
  uplift: { delta: number };
  cost: CostReport;
};
type RefusalReport = { status: "refused"; reason: string; detail: string };
type Report = MeasuredReport | RefusalReport;
type VerifyResultLike =
  | {
      status: "verified";
      verdict: "pass" | "fail";
      fail_reason: string | null;
      sha: string | null;
      control_verdict: string | null;
    }
  | { status: "rejected"; reason: string };
type RootLike =
  | { kind: "issue"; number: number }
  | { kind: "operator_bundle"; id: string }
  | { kind: "synthetic"; id: string };
type LockEntry = {
  family_id: string;
  variant_id: string;
  root: RootLike;
  failure_type: null;
  synthetic: boolean;
  expect_blocked: boolean;
  base_sha: string;
  task_digest: string;
  source_root_handoff_digests: string[];
  content_digest: string;
  assertion_set_digest: string;
};
type Lock = { schema_version: 1; entries: LockEntry[]; digest: string };
type CapsuleOpts = {
  recipes: readonly JsonObject[];
  verifier: unknown;
  resolveFixture: (ref: unknown) => unknown;
  lock: unknown;
  unseal: unknown;
  split: string;
  minFamilies: number;
  seed: number;
  B?: number;
};
type MeasureFn = (episodes: readonly JsonObject[], opts: CapsuleOpts) => Promise<Report>;

const MOD_URL = new URL("../../src/evals/capsule-uplift.ts", import.meta.url).href;

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

const measureCapsuleUplift = (): MeasureFn => mod?.["measureCapsuleUplift"] as MeasureFn;

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const TOOLS_SHA = "d".repeat(40);
const DEP_LOCK = "f".repeat(64);
const TASK_DIGEST = "2".repeat(64);
const CONTENT_DIGEST = "3".repeat(64);
const ASSERTION_DIGEST = "4".repeat(64);
const COMPONENT_SHA = "7".repeat(64);
const CAPSULE_SHA = "8".repeat(64);
const GRADER_BUILD = "9".repeat(64);

function digest(i: number): string {
  return i.toString(16).padStart(64, "0");
}

function identityUnknown(): JsonObject {
  return { value: null, provenance: "unknown", missing_reason: "x" };
}

function modelIdentity(effective: JsonObject): JsonObject {
  return {
    requested: identityUnknown(),
    effective,
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

function attTokens(n: number, headSha: string | null, tokens: number): JsonObject {
  return { ...att(n, headSha), usage: { tokens, cost_usd: null, scope: "attempt" } };
}

function makeEpisode(overrides: JsonObject = {}): JsonObject {
  const familyId = (overrides["family_id"] as string | undefined) ?? "fam-syn-a";
  const fixtureRef =
    "fixture_ref" in overrides
      ? overrides["fixture_ref"]
      : { family_id: familyId, variant_id: "v1" };
  const episode: JsonObject = {
    schema_version: 1,
    episode_id: "e1",
    family_id: familyId,
    fixture_ref: fixtureRef,
    split: "dev",
    design: "controlled",
    failure_type: null,
    task_digest: null,
    task_refs: { issues: [], bundle_ids: [] },
    repo: { base_sha: BASE_SHA, dependency_lock_sha256: DEP_LOCK },
    recipe_id: "minimal-v1",
    model_identity: modelIdentity({ value: "qwen3-x", provenance: "acp_selected" }),
    harness_build: { sha: TOOLS_SHA },
    environment: { worktree_kind: null, os: null, bun_version: null },
    lineage: { root_handoff_id: null, handoff_ids: [], shape: "single" },
    attempt_history: {
      status: "complete",
      reason: null,
      count: 1,
      count_basis: "claim_events",
    },
    attempts: [att(1, SHA)],
    assistance: [],
    final_sha: SHA,
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
    sha: overrides.sha ?? SHA,
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

function solveEp(
  table: Map<string, VerifyResultLike | "throw">,
  overrides: JsonObject,
): JsonObject {
  const id = String(overrides["episode_id"]);
  const d = digest(table.size + 1);
  table.set(`${id}:${d}`, verifiedResult("pass", null, SHA));
  return makeEpisode({
    ...overrides,
    episode_id: id,
    receipts: [hiddenReceipt({ digest: d, sha: SHA })],
  });
}

function failEp(overrides: JsonObject): JsonObject {
  return makeEpisode({
    ...overrides,
    observed_outcome: { class: "model_failure", reason: "hidden_failed" },
  });
}

function makeRecipe(overrides: JsonObject = {}): JsonObject {
  const recipe: JsonObject = {
    recipe_id: "minimal-v1",
    arm: "minimal",
    components: { base: { status: "materialized", sha256: COMPONENT_SHA } },
    limits: { max_rounds: 3 },
    seed: { value: 7, supported: true },
    ...overrides,
  };
  const parsed = RecipeSchema.safeParse(recipe);
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.issues));
  }
  expect(parsed.success).toBe(true);
  return recipe;
}

function lockEntry(root: RootLike): LockEntry {
  const familyId =
    root.kind === "issue"
      ? `fam-${String(root.number)}`
      : root.kind === "operator_bundle"
        ? `fam-op-${root.id}`
        : `fam-syn-${root.id}`;
  return {
    family_id: familyId,
    variant_id: "v1",
    root,
    failure_type: null,
    synthetic: root.kind === "synthetic",
    expect_blocked: false,
    base_sha: BASE_SHA,
    task_digest: TASK_DIGEST,
    source_root_handoff_digests: [],
    content_digest: CONTENT_DIGEST,
    assertion_set_digest: ASSERTION_DIGEST,
  };
}

function makeLock(entries: LockEntry[]): Lock {
  const lock: Lock = { schema_version: 1, entries, digest: computeLockDigest(entries) };
  expect(() => verifyHoldoutLock(lock)).not.toThrow();
  return lock;
}

const ENTRY777 = lockEntry({ kind: "issue", number: 777 });
const LOCK777 = makeLock([ENTRY777]);
const TOKEN = unsealHoldout(LOCK777, { sha256: "0".repeat(64), max_unseals: 1 });

function pairFixture(fam: string, variant: string): JsonObject {
  return { family_id: fam, variant_id: variant };
}

const MINIMAL = makeRecipe();
const CAPSULE = makeRecipe({
  recipe_id: "capsule-v1",
  arm: "capsule",
  components: {
    base: { status: "materialized", sha256: COMPONENT_SHA },
    capsule: { status: "materialized", sha256: CAPSULE_SHA },
  },
});

function baseOpts(overrides: Partial<CapsuleOpts> = {}): CapsuleOpts {
  return {
    recipes: [MINIMAL, CAPSULE],
    verifier: fakeVerifier(new Map()),
    resolveFixture: () => null,
    lock: null,
    unseal: null,
    split: "dev",
    minFamilies: 1,
    seed: 1,
    B: 200,
    ...overrides,
  };
}

function measured(report: Report): MeasuredReport {
  if (report.status !== "measured") {
    throw new Error(`expected a measured report, got ${JSON.stringify(report)}`);
  }
  return report;
}

async function expectRefusal(
  episodes: readonly JsonObject[],
  opts: CapsuleOpts,
  reason: string,
  detail: unknown = expect.any(String),
): Promise<void> {
  const report = await measureCapsuleUplift()(episodes, opts);
  expect(report).toEqual({ status: "refused", reason, detail: detail as string });
}

function devPair(): JsonObject[] {
  return [
    failEp({ episode_id: "B-dev", recipe_id: "minimal-v1" }),
    failEp({ episode_id: "T-dev", recipe_id: "capsule-v1" }),
  ];
}

type Arm = "baseline" | "treatment";
type Outcome = "solve" | "fail";

function armEpisode(
  table: Map<string, VerifyResultLike | "throw">,
  arm: Arm,
  fam: string,
  variant: string,
  outcome: Outcome,
  overrides: JsonObject = {},
): JsonObject {
  const fields: JsonObject = {
    episode_id: `${arm}-${fam}-${variant}`,
    recipe_id: arm === "baseline" ? "minimal-v1" : "capsule-v1",
    family_id: fam,
    fixture_ref: pairFixture(fam, variant),
    ...overrides,
  };
  return outcome === "solve" ? solveEp(table, fields) : failEp(fields);
}

function cohort(
  table: Map<string, VerifyResultLike | "throw">,
  rows: readonly {
    fam: string;
    variants: readonly string[];
    baseline: Outcome;
    treatment: Outcome;
  }[],
): JsonObject[] {
  const episodes: JsonObject[] = [];
  for (const row of rows) {
    for (const variant of row.variants) {
      episodes.push(
        armEpisode(table, "baseline", row.fam, variant, row.baseline),
        armEpisode(table, "treatment", row.fam, variant, row.treatment),
      );
    }
  }
  return episodes;
}

test("1: a recipe set without a capsule arm is refused recipe_missing", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  await expectRefusal(devPair(), baseOpts({ recipes: [MINIMAL] }), "recipe_missing");
});

test("2: two capsule-arm recipes are refused recipe_ambiguous", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const capsuleAlt = makeRecipe({
    recipe_id: "capsule-v2",
    arm: "capsule",
    components: {
      base: { status: "materialized", sha256: COMPONENT_SHA },
      capsule: { status: "materialized", sha256: CAPSULE_SHA },
    },
  });
  await expectRefusal(
    devPair(),
    baseOpts({ recipes: [MINIMAL, CAPSULE, capsuleAlt] }),
    "recipe_ambiguous",
  );
});

test("3: capsule recipes that are not a single-component ablation are refused", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const variants: JsonObject[] = [
    makeRecipe({
      recipe_id: "capsule-v1",
      arm: "capsule",
      components: {
        base: { status: "materialized", sha256: "6".repeat(64) },
        capsule: { status: "materialized", sha256: CAPSULE_SHA },
      },
    }),
    makeRecipe({
      recipe_id: "capsule-v1",
      arm: "capsule",
      components: {
        base: { status: "materialized", sha256: COMPONENT_SHA },
        capsule: { status: "materialized", sha256: CAPSULE_SHA },
        memory: { status: "materialized", sha256: "5".repeat(64) },
      },
    }),
    makeRecipe({
      recipe_id: "capsule-v1",
      arm: "capsule",
      components: { base: { status: "materialized", sha256: COMPONENT_SHA } },
    }),
  ];
  for (const capsule of variants) {
    await expectRefusal(
      devPair(),
      baseOpts({ recipes: [MINIMAL, capsule] }),
      "not_single_component_ablation",
    );
  }
  const minimalWithCapsule = makeRecipe({
    recipe_id: "minimal-v1",
    arm: "minimal",
    components: {
      base: { status: "materialized", sha256: COMPONENT_SHA },
      capsule: { status: "materialized", sha256: CAPSULE_SHA },
    },
  });
  await expectRefusal(
    devPair(),
    baseOpts({ recipes: [minimalWithCapsule, CAPSULE] }),
    "not_single_component_ablation",
  );
});

test("4: a capsule recipe with drifted limits is refused pairing_drift", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const capsuleDrift = makeRecipe({
    recipe_id: "capsule-v1",
    arm: "capsule",
    components: {
      base: { status: "materialized", sha256: COMPONENT_SHA },
      capsule: { status: "materialized", sha256: CAPSULE_SHA },
    },
    limits: { max_rounds: 4 },
  });
  await expectRefusal(
    devPair(),
    baseOpts({ recipes: [MINIMAL, capsuleDrift] }),
    "pairing_drift",
    expect.stringContaining("limits"),
  );
});

test("4b: a capsule recipe with a different seed is refused pairing_drift", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const capsuleSeedDrift = makeRecipe({
    recipe_id: "capsule-v1",
    arm: "capsule",
    components: {
      base: { status: "materialized", sha256: COMPONENT_SHA },
      capsule: { status: "materialized", sha256: CAPSULE_SHA },
    },
    seed: { value: 8, supported: true },
  });
  await expectRefusal(
    devPair(),
    baseOpts({ recipes: [MINIMAL, capsuleSeedDrift] }),
    "pairing_drift",
    expect.stringContaining("seed"),
  );
});

test("5: a pending capsule component is refused arm_unavailable with its blocker", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const capsulePending = makeRecipe({
    recipe_id: "capsule-v1",
    arm: "capsule",
    components: {
      base: { status: "materialized", sha256: COMPONENT_SHA },
      capsule: { status: "pending_upstream", blocked_on: "#392" },
    },
  });
  await expectRefusal(
    devPair(),
    baseOpts({ recipes: [MINIMAL, capsulePending] }),
    "arm_unavailable",
    expect.stringContaining("#392"),
  );
});

test("6: an observational episode is refused observational_episodes", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const observational = makeEpisode({
    episode_id: "O",
    design: "observational",
    fixture_ref: null,
    recipe_id: null,
  });
  const report = await measureCapsuleUplift()([...devPair(), observational], baseOpts());
  expect(report).toEqual({
    status: "refused",
    reason: "observational_episodes",
    detail: expect.any(String) as string,
  });
});

test("6b: an observational episode on the non-measured split is still refused observational_episodes", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const devPairEpisodes = devPair();
  const observationalOnHoldout = makeEpisode({
    episode_id: "O-holdout",
    design: "observational",
    split: "holdout",
    fixture_ref: null,
    recipe_id: null,
  });
  const report = await measureCapsuleUplift()(
    [...devPairEpisodes, observationalOnHoldout],
    baseOpts(),
  );
  expect(report).toEqual({
    status: "refused",
    reason: "observational_episodes",
    detail: expect.any(String) as string,
  });
});

test("7: holdout measurement is refused sealed without a lock and unseal token", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const holdoutPair = [
    armEpisode(table, "baseline", "fam-777", "v1", "solve", { split: "holdout" }),
    armEpisode(table, "treatment", "fam-777", "v1", "fail", { split: "holdout" }),
  ];
  const verifier = fakeVerifier(table);
  await expectRefusal(
    holdoutPair,
    baseOpts({ split: "holdout", lock: null, unseal: null, verifier }),
    "holdout_sealed",
  );
  await expectRefusal(
    holdoutPair,
    baseOpts({ split: "holdout", lock: LOCK777, unseal: null, verifier }),
    "holdout_sealed",
  );
  const report = measured(
    await measureCapsuleUplift()(
      holdoutPair,
      baseOpts({ split: "holdout", lock: LOCK777, unseal: TOKEN, verifier }),
    ),
  );
  expect(report.held_out).toBe(true);
  expect(report.evidence).toBe("held_out");
  expect(report.comparison.holdout).toBe("unsealed");
});

test("8: a dev cohort measures a controlled paired ablation and ignores holdout rows", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const episodes = cohort(table, [
    { fam: "fam-dev-a", variants: ["v1"], baseline: "fail", treatment: "solve" },
    { fam: "fam-dev-b", variants: ["v1"], baseline: "fail", treatment: "solve" },
    { fam: "fam-dev-c", variants: ["v1"], baseline: "solve", treatment: "fail" },
    { fam: "fam-dev-d", variants: ["v1"], baseline: "solve", treatment: "solve" },
  ]);
  episodes.push(
    armEpisode(table, "baseline", "fam-777", "v1", "solve", { split: "holdout" }),
    armEpisode(table, "treatment", "fam-777", "v1", "fail", { split: "holdout" }),
  );
  const report = measured(
    await measureCapsuleUplift()(episodes, baseOpts({ verifier: fakeVerifier(table) })),
  );
  expect(report.status).toBe("measured");
  expect(report.design).toBe("controlled_paired_ablation");
  expect(report.held_out).toBe(false);
  expect(report.evidence).toBe("dev_only");
  expect(report.baseline_recipe_id).toBe("minimal-v1");
  expect(report.treatment_recipe_id).toBe("capsule-v1");
  expect(report.comparison.n_pairs).toBe(4);
  const treatmentRate = report.comparison.treatment.rate;
  const baselineRate = report.comparison.baseline.rate;
  expect(treatmentRate).not.toBeNull();
  expect(baselineRate).not.toBeNull();
  expect(report.uplift.delta).toBeCloseTo((treatmentRate ?? 0) - (baselineRate ?? 0));
});

test("9a: a cohort under minFamilies is underpowered", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const episodes = cohort(table, [
    { fam: "fam-p1", variants: ["v1"], baseline: "solve", treatment: "solve" },
    { fam: "fam-p2", variants: ["v1"], baseline: "fail", treatment: "solve" },
    { fam: "fam-p3", variants: ["v1"], baseline: "solve", treatment: "fail" },
  ]);
  const report = measured(
    await measureCapsuleUplift()(
      episodes,
      baseOpts({ verifier: fakeVerifier(table), minFamilies: 10 }),
    ),
  );
  expect(report.verdict).toBe("underpowered");
});

test("9b: capsule solving every family the baseline fails is improved", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const episodes = cohort(table, [
    { fam: "fam-i1", variants: ["v1"], baseline: "fail", treatment: "solve" },
    { fam: "fam-i2", variants: ["v1"], baseline: "fail", treatment: "solve" },
    { fam: "fam-i3", variants: ["v1"], baseline: "fail", treatment: "solve" },
    { fam: "fam-i4", variants: ["v1"], baseline: "fail", treatment: "solve" },
  ]);
  const report = measured(
    await measureCapsuleUplift()(
      episodes,
      baseOpts({ verifier: fakeVerifier(table), minFamilies: 2 }),
    ),
  );
  expect(report.verdict).toBe("improved");
});

test("9c: the capsule failing every family the baseline solves is regressed", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const episodes = cohort(table, [
    { fam: "fam-r1", variants: ["v1"], baseline: "solve", treatment: "fail" },
    { fam: "fam-r2", variants: ["v1"], baseline: "solve", treatment: "fail" },
    { fam: "fam-r3", variants: ["v1"], baseline: "solve", treatment: "fail" },
    { fam: "fam-r4", variants: ["v1"], baseline: "solve", treatment: "fail" },
  ]);
  const report = measured(
    await measureCapsuleUplift()(
      episodes,
      baseOpts({ verifier: fakeVerifier(table), minFamilies: 2 }),
    ),
  );
  expect(report.verdict).toBe("regressed");
});

test("9d: equal arm rates with overlapping cluster intervals are inconclusive", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const episodes = cohort(table, [
    { fam: "fam-n1", variants: ["v1"], baseline: "solve", treatment: "solve" },
    { fam: "fam-n2", variants: ["v1"], baseline: "solve", treatment: "fail" },
    { fam: "fam-n3", variants: ["v1"], baseline: "fail", treatment: "solve" },
    { fam: "fam-n4", variants: ["v1"], baseline: "fail", treatment: "fail" },
  ]);
  const report = measured(
    await measureCapsuleUplift()(episodes, baseOpts({ verifier: fakeVerifier(table) })),
  );
  expect(report.verdict).toBe("inconclusive");
});

test("10a: context tokens sum per episode, track missingness and delta the median", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const episodes = [
    failEp({
      episode_id: "B-cost-a",
      recipe_id: "minimal-v1",
      family_id: "fam-cost-a",
      fixture_ref: pairFixture("fam-cost-a", "v1"),
      attempts: [attTokens(1, SHA, 40), attTokens(2, SHA, 60)],
      attempt_history: {
        status: "complete",
        reason: null,
        count: 2,
        count_basis: "claim_events",
      },
    }),
    failEp({
      episode_id: "T-cost-a-1",
      recipe_id: "capsule-v1",
      family_id: "fam-cost-a",
      fixture_ref: pairFixture("fam-cost-a", "v1"),
      attempts: [attTokens(1, SHA, 40)],
    }),
    failEp({
      episode_id: "T-cost-a-2",
      recipe_id: "capsule-v1",
      family_id: "fam-cost-a",
      fixture_ref: pairFixture("fam-cost-a", "v1"),
    }),
    failEp({
      episode_id: "B-cost-b",
      recipe_id: "minimal-v1",
      family_id: "fam-cost-b",
      fixture_ref: pairFixture("fam-cost-b", "v1"),
      attempts: [attTokens(1, SHA, 300)],
    }),
    failEp({
      episode_id: "T-cost-b",
      recipe_id: "capsule-v1",
      family_id: "fam-cost-b",
      fixture_ref: pairFixture("fam-cost-b", "v1"),
      attempts: [attTokens(1, SHA, 60)],
    }),
  ];
  const report = measured(await measureCapsuleUplift()(episodes, baseOpts()));
  expect(report.cost.baseline.context_tokens).toEqual({
    sum: 400,
    median_per_episode: 200,
    n_missing: 0,
  });
  expect(report.cost.treatment.context_tokens).toEqual({
    sum: 100,
    median_per_episode: 50,
    n_missing: 1,
  });
  expect(report.cost.context_token_delta).toBe(-150);
});

test("10b: tool permission errors count per arm and unpaired rows count nowhere", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const episodes = [
    failEp({
      episode_id: "B-te-a",
      recipe_id: "minimal-v1",
      family_id: "fam-te-a",
      fixture_ref: pairFixture("fam-te-a", "v1"),
    }),
    failEp({
      episode_id: "T-te-a",
      recipe_id: "capsule-v1",
      family_id: "fam-te-a",
      fixture_ref: pairFixture("fam-te-a", "v1"),
      failure_type: "tool_permission_error",
    }),
    failEp({
      episode_id: "B-te-b",
      recipe_id: "minimal-v1",
      family_id: "fam-te-b",
      fixture_ref: pairFixture("fam-te-b", "v1"),
    }),
    failEp({
      episode_id: "T-te-b",
      recipe_id: "capsule-v1",
      family_id: "fam-te-b",
      fixture_ref: pairFixture("fam-te-b", "v1"),
    }),
    failEp({
      episode_id: "T-te-c",
      recipe_id: "capsule-v1",
      family_id: "fam-te-c",
      fixture_ref: pairFixture("fam-te-c", "v1"),
      failure_type: "tool_permission_error",
    }),
  ];
  const report = measured(await measureCapsuleUplift()(episodes, baseOpts()));
  expect(report.comparison.treatment.tool_permission_errors).toBe(1);
  expect(report.comparison.treatment.n_episodes).toBe(2);
  expect(report.comparison.treatment.tool_error_rate).toBeCloseTo(0.5);
  expect(report.comparison.baseline.tool_permission_errors).toBe(0);
  expect(report.comparison.baseline.tool_error_rate).toBeCloseTo(0);
  expect(report.cost.tool_error_rate_delta).toBeCloseTo(0.5);
});

test("10c: a grader-attributed environment failure counts apart from tool errors", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const envEpisode = makeEpisode({
    episode_id: "T-env-a",
    recipe_id: "capsule-v1",
    family_id: "fam-env-a",
    fixture_ref: pairFixture("fam-env-a", "v1"),
    observed_outcome: {
      class: "environment_failure",
      kind: "environment",
      env_evidence: {
        source: "grader_control_failed",
        ref: "evt-1",
        observed_at: null,
        first_model_turn_at: null,
      },
    },
  });
  expect(EpisodeSchema.safeParse(envEpisode).success).toBe(true);
  const episodes = [
    failEp({
      episode_id: "B-env-a",
      recipe_id: "minimal-v1",
      family_id: "fam-env-a",
      fixture_ref: pairFixture("fam-env-a", "v1"),
    }),
    envEpisode,
  ];
  const report = measured(await measureCapsuleUplift()(episodes, baseOpts()));
  expect(report.comparison.treatment.environment_failures).toBe(1);
  expect(report.comparison.treatment.tool_permission_errors).toBe(0);
  expect(report.comparison.baseline.environment_failures).toBe(0);
});

test("11: the report is identical under episode reordering", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const episodes = cohort(table, [
    { fam: "fam-det-a", variants: ["v1", "v2"], baseline: "solve", treatment: "solve" },
    { fam: "fam-det-b", variants: ["v1"], baseline: "solve", treatment: "fail" },
    { fam: "fam-det-c", variants: ["v1", "v2"], baseline: "fail", treatment: "solve" },
    { fam: "fam-det-d", variants: ["v1"], baseline: "fail", treatment: "solve" },
    { fam: "fam-det-e", variants: ["v1"], baseline: "fail", treatment: "fail" },
  ]);
  const opts = baseOpts({ verifier: fakeVerifier(table), B: 200 });
  const expected = await measureCapsuleUplift()(episodes, opts);
  const reversed = await measureCapsuleUplift()([...episodes].reverse(), opts);
  const permuted = [
    ...episodes.filter((_, i) => i % 2 === 0),
    ...episodes.filter((_, i) => i % 2 === 1),
  ];
  const shuffled = await measureCapsuleUplift()(permuted, opts);
  expect(reversed).toEqual(expected);
  expect(shuffled).toEqual(expected);
});
