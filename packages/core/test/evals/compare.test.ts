import { beforeAll, expect, test } from "bun:test";

import { computeLockDigest, unsealHoldout, verifyHoldoutLock } from "@src/evals/holdout.js";
import { EpisodeSchema, RecipeSchema } from "@src/evals/manifest.js";

type JsonObject = Record<string, unknown>;

// Input and output shapes are declared locally: compare.ts does not exist at
// the base, so no value or type may be imported from it.
type Interval = { lo: number; hi: number };
type Exclusion = { episode_id: string; reason: string };
type ArmReport = {
  s: number;
  n: number;
  n_unknown: number;
  n_excluded: number;
  rate: number | null;
  wilson: Interval | null;
  cluster_ci: Interval | null;
};
type PairedReport = {
  n_pairs: number;
  n_families: number;
  underpowered: boolean;
  holdout: "none" | "sealed" | "unsealed";
  discordant: { baseline_only: number; treatment_only: number };
  baseline: ArmReport;
  treatment: ArmReport;
  excluded: Exclusion[];
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
type CompareOpts = {
  baseline: string;
  treatment: string;
  recipes: readonly JsonObject[];
  verifier: unknown;
  resolveFixture: (ref: unknown) => unknown;
  lock: unknown;
  unseal: unknown;
  minFamilies: number;
  seed: number;
  B?: number;
};
type CompareFn = (episodes: readonly JsonObject[], opts: CompareOpts) => Promise<PairedReport>;

const MOD_URL = new URL("../../src/evals/compare.ts", import.meta.url).href;

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

const comparePaired = (): CompareFn => mod?.["comparePaired"] as CompareFn;

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const BASE_SHA_ALT = "c".repeat(40);
const TOOLS_SHA = "d".repeat(40);
const TOOLS_SHA_ALT = "e".repeat(40);
const DEP_LOCK = "f".repeat(64);
const DEP_LOCK_ALT = "1".repeat(64);
const TASK_DIGEST = "2".repeat(64);
const CONTENT_DIGEST = "3".repeat(64);
const ASSERTION_DIGEST = "4".repeat(64);
const COMPONENT_SHA = "7".repeat(64);
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

const MINIMAL = makeRecipe();
const BOUNDED = makeRecipe({ recipe_id: "bounded_repair-v1", arm: "bounded_repair" });

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

function baseOpts(overrides: Partial<CompareOpts> = {}): CompareOpts {
  return {
    baseline: "minimal",
    treatment: "bounded_repair",
    recipes: [MINIMAL, BOUNDED],
    verifier: fakeVerifier(new Map()),
    resolveFixture: () => null,
    lock: null,
    unseal: null,
    minFamilies: 1,
    seed: 1,
    B: 200,
    ...overrides,
  };
}

async function rejectionName(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err instanceof Error ? err.name : null;
  }
}

function pairFixture(fam: string, variant: string): JsonObject {
  return { family_id: fam, variant_id: variant };
}

function holdoutEpisode(id: string, recipeId: string, fam: string): JsonObject {
  return makeEpisode({
    episode_id: id,
    recipe_id: recipeId,
    family_id: fam,
    fixture_ref: pairFixture(fam, "v1"),
    split: "holdout",
  });
}

test("1: observational episodes are rejected, while B and T alone pair", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const B = makeEpisode({ episode_id: "B", recipe_id: "minimal-v1" });
  const T = makeEpisode({ episode_id: "T", recipe_id: "bounded_repair-v1" });
  const O = makeEpisode({
    episode_id: "O",
    design: "observational",
    fixture_ref: null,
    recipe_id: null,
  });
  const name = await rejectionName(comparePaired()([B, T, O], baseOpts()));
  expect(name).toBe("ObservationalComparisonError");
  const res = await comparePaired()([B, T], baseOpts());
  expect(res.n_pairs).toBe(1);
});

test("2: each mismatched pair key excludes both sides with its reason", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expect(mod["PAIR_KEYS"]).toEqual([
    "fixture_ref",
    "base_sha",
    "dependency_lock_sha256",
    "effective_model",
    "tools_sha",
    "limits",
    "seed",
  ]);
  const rows: { key: string; tweak: JsonObject; recipes?: JsonObject[] }[] = [
    { key: "fixture_ref", tweak: { fixture_ref: pairFixture("fam-syn-a", "v2") } },
    {
      key: "base_sha",
      tweak: { repo: { base_sha: BASE_SHA_ALT, dependency_lock_sha256: DEP_LOCK } },
    },
    {
      key: "dependency_lock_sha256",
      tweak: { repo: { base_sha: BASE_SHA, dependency_lock_sha256: DEP_LOCK_ALT } },
    },
    {
      key: "effective_model",
      tweak: { model_identity: modelIdentity({ value: "qwen3-y", provenance: "acp_selected" }) },
    },
    { key: "tools_sha", tweak: { harness_build: { sha: TOOLS_SHA_ALT } } },
    {
      key: "limits",
      tweak: {},
      recipes: [
        MINIMAL,
        makeRecipe({
          recipe_id: "bounded_repair-v1",
          arm: "bounded_repair",
          limits: { max_rounds: 4 },
        }),
      ],
    },
    {
      key: "seed",
      tweak: {},
      recipes: [
        MINIMAL,
        makeRecipe({
          recipe_id: "bounded_repair-v1",
          arm: "bounded_repair",
          seed: { value: 8, supported: true },
        }),
      ],
    },
  ];
  for (const row of rows) {
    const B = makeEpisode({ episode_id: "B", recipe_id: "minimal-v1" });
    const T = makeEpisode({ episode_id: "T", recipe_id: "bounded_repair-v1", ...row.tweak });
    const res = await comparePaired()(
      [B, T],
      baseOpts({ recipes: row.recipes ?? [MINIMAL, BOUNDED] }),
    );
    expect(res.n_pairs).toBe(0);
    expect(res.excluded).toEqual([
      { episode_id: "B", reason: `mismatch:${row.key}` },
      { episode_id: "T", reason: `mismatch:${row.key}` },
    ]);
  }
});

test("3: unattested effective model identities exclude both sides", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const identities: JsonObject[] = [
    { value: null, provenance: "unknown", missing_reason: "x" },
    { value: null, provenance: "unattested", missing_reason: "x" },
    { value: "qwen3-x", provenance: "acp_current" },
  ];
  for (const effective of identities) {
    const B = makeEpisode({
      episode_id: "B",
      recipe_id: "minimal-v1",
      model_identity: modelIdentity(effective),
    });
    const T = makeEpisode({
      episode_id: "T",
      recipe_id: "bounded_repair-v1",
      model_identity: modelIdentity(effective),
    });
    const res = await comparePaired()([B, T], baseOpts());
    expect(res.n_pairs).toBe(0);
    expect(res.excluded).toEqual([
      { episode_id: "B", reason: "effective_model_unattested" },
      { episode_id: "T", reason: "effective_model_unattested" },
    ]);
  }
});

test("3b: a null base_sha excludes both sides as missing", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const repo = { base_sha: null, dependency_lock_sha256: DEP_LOCK };
  const B = makeEpisode({ episode_id: "B", recipe_id: "minimal-v1", repo });
  const T = makeEpisode({ episode_id: "T", recipe_id: "bounded_repair-v1", repo });
  const res = await comparePaired()([B, T], baseOpts());
  expect(res.n_pairs).toBe(0);
  expect(res.excluded).toEqual([
    { episode_id: "B", reason: "missing:base_sha" },
    { episode_id: "T", reason: "missing:base_sha" },
  ]);
});

test("4: three same-seed baseline repeats collapse into one pair", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const episodes = [
    solveEp(table, { episode_id: "B1", recipe_id: "minimal-v1" }),
    solveEp(table, { episode_id: "B2", recipe_id: "minimal-v1" }),
    solveEp(table, { episode_id: "B3", recipe_id: "minimal-v1" }),
    failEp({ episode_id: "T", recipe_id: "bounded_repair-v1" }),
  ];
  const res = await comparePaired()(episodes, baseOpts({ verifier: fakeVerifier(table) }));
  expect(res.n_pairs).toBe(1);
  expect(res.excluded).toEqual([]);
  expect(res.baseline.s).toBe(1);
  expect(res.baseline.n).toBe(1);
  expect(res.treatment.s).toBe(0);
  expect(res.treatment.n).toBe(1);
});

test("5: a Nov 1-2-shaped cohort over three families is underpowered", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const buildCohort = (
    table: Map<string, VerifyResultLike | "throw">,
    fams: readonly string[],
    variants: readonly string[],
  ): JsonObject[] => {
    const episodes: JsonObject[] = [];
    for (const fam of fams) {
      for (const variant of variants) {
        episodes.push(
          solveEp(table, {
            episode_id: `B-${fam}-${variant}`,
            recipe_id: "minimal-v1",
            family_id: fam,
            fixture_ref: pairFixture(fam, variant),
          }),
          failEp({
            episode_id: `T-${fam}-${variant}`,
            recipe_id: "bounded_repair-v1",
            family_id: fam,
            fixture_ref: pairFixture(fam, variant),
          }),
        );
      }
    }
    return episodes;
  };
  const table = new Map<string, VerifyResultLike | "throw">();
  const under = await comparePaired()(
    buildCohort(table, ["fam-syn-a", "fam-syn-b", "fam-syn-c"], ["v1", "v2", "v3", "v4", "v5"]),
    baseOpts({ verifier: fakeVerifier(table), minFamilies: 10 }),
  );
  expect(under.n_pairs).toBe(15);
  expect(under.n_families).toBe(3);
  expect(under.underpowered).toBe(true);
  expect(under.baseline.cluster_ci).toBeNull();
  expect(under.treatment.cluster_ci).toBeNull();
  const table2 = new Map<string, VerifyResultLike | "throw">();
  const fams15 = Array.from({ length: 15 }, (_, i) => `fam-syn-p${String(i).padStart(2, "0")}`);
  const powered = await comparePaired()(
    buildCohort(table2, fams15, ["v1"]),
    baseOpts({ verifier: fakeVerifier(table2), minFamilies: 10 }),
  );
  expect(powered.n_pairs).toBe(15);
  expect(powered.n_families).toBe(15);
  expect(powered.underpowered).toBe(false);
  expect(powered.baseline.cluster_ci).not.toBeNull();
});

test("8a: holdout-split episodes stay sealed without a token", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const dev = [
    solveEp(table, { episode_id: "dev-B", recipe_id: "minimal-v1" }),
    failEp({ episode_id: "dev-T", recipe_id: "bounded_repair-v1" }),
  ];
  const holdoutPair = [
    holdoutEpisode("ep-B-fam-777", "minimal-v1", "fam-777"),
    holdoutEpisode("ep-T-fam-777", "bounded_repair-v1", "fam-777"),
  ];
  const sealed = await comparePaired()(
    [...dev, ...holdoutPair],
    baseOpts({ verifier: fakeVerifier(table), lock: LOCK777, unseal: null }),
  );
  expect(sealed.n_pairs).toBe(1);
  expect(sealed.holdout).toBe("sealed");
  const sealedJson = JSON.stringify(sealed);
  expect(sealedJson).not.toContain("ep-B-fam-777");
  expect(sealedJson).not.toContain("ep-T-fam-777");
  const unsealed = await comparePaired()(
    [...dev, ...holdoutPair],
    baseOpts({ verifier: fakeVerifier(table), lock: LOCK777, unseal: TOKEN }),
  );
  expect(unsealed.n_pairs).toBe(2);
  expect(unsealed.holdout).toBe("unsealed");
});

test("8c: the lock seals by family and issue root, not only the split label", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const dev = [
    solveEp(table, { episode_id: "dev-B", recipe_id: "minimal-v1" }),
    failEp({ episode_id: "dev-T", recipe_id: "bounded_repair-v1" }),
  ];
  const lockFamily = [
    makeEpisode({
      episode_id: "ep-B-fam-777",
      recipe_id: "minimal-v1",
      family_id: "fam-777",
      fixture_ref: pairFixture("fam-777", "v1"),
      split: "dev",
    }),
    makeEpisode({
      episode_id: "ep-T-fam-777",
      recipe_id: "bounded_repair-v1",
      family_id: "fam-777",
      fixture_ref: pairFixture("fam-777", "v1"),
      split: "dev",
    }),
  ];
  const issueRoot = [
    makeEpisode({
      episode_id: "ep-B-issue-777",
      recipe_id: "minimal-v1",
      family_id: "fam-syn-b",
      fixture_ref: pairFixture("fam-syn-b", "v1"),
      split: "dev",
      task_refs: { issues: [777], bundle_ids: [] },
    }),
    makeEpisode({
      episode_id: "ep-T-issue-777",
      recipe_id: "bounded_repair-v1",
      family_id: "fam-syn-b",
      fixture_ref: pairFixture("fam-syn-b", "v1"),
      split: "dev",
      task_refs: { issues: [777], bundle_ids: [] },
    }),
  ];
  const res = await comparePaired()(
    [...dev, ...lockFamily, ...issueRoot],
    baseOpts({ verifier: fakeVerifier(table), lock: LOCK777, unseal: null }),
  );
  expect(res.n_pairs).toBe(1);
  expect(res.holdout).toBe("sealed");
  const json = JSON.stringify(res);
  for (const id of ["ep-B-fam-777", "ep-T-fam-777", "ep-B-issue-777", "ep-T-issue-777"]) {
    expect(json).not.toContain(id);
  }
});

test("8d: a null lock still seals holdout-split episodes", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const dev = [
    solveEp(table, { episode_id: "dev-B", recipe_id: "minimal-v1" }),
    failEp({ episode_id: "dev-T", recipe_id: "bounded_repair-v1" }),
  ];
  const holdoutPair = [
    holdoutEpisode("ep-B-fam-syn-z", "minimal-v1", "fam-syn-z"),
    holdoutEpisode("ep-T-fam-syn-z", "bounded_repair-v1", "fam-syn-z"),
  ];
  const res = await comparePaired()(
    [...dev, ...holdoutPair],
    baseOpts({ verifier: fakeVerifier(table), lock: null, unseal: null }),
  );
  expect(res.n_pairs).toBe(1);
  expect(res.holdout).toBe("sealed");
  const json = JSON.stringify(res);
  for (const id of ["ep-B-fam-syn-z", "ep-T-fam-syn-z"]) {
    expect(json).not.toContain(id);
  }
  const control = await comparePaired()(dev, baseOpts({ verifier: fakeVerifier(table) }));
  expect(control.holdout).toBe("none");
});

test("10b: a tampered lock fails closed", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const tampered: JsonObject = {
    schema_version: 1,
    entries: [{ ...ENTRY777, synthetic: true }],
    digest: LOCK777.digest,
  };
  const table = new Map<string, VerifyResultLike | "throw">();
  const dev = [
    solveEp(table, { episode_id: "dev-B", recipe_id: "minimal-v1" }),
    failEp({ episode_id: "dev-T", recipe_id: "bounded_repair-v1" }),
  ];
  const holdoutPair = [
    holdoutEpisode("ep-B-fam-777", "minimal-v1", "fam-777"),
    holdoutEpisode("ep-T-fam-777", "bounded_repair-v1", "fam-777"),
  ];
  const name = await rejectionName(
    comparePaired()(
      [...dev, ...holdoutPair],
      baseOpts({ verifier: fakeVerifier(table), lock: tampered, unseal: null }),
    ),
  );
  expect(name).toBe("HoldoutLockError");
});

test("11: paired statistics count discordance and per-arm verified rates", async () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const table = new Map<string, VerifyResultLike | "throw">();
  const episodes = [
    solveEp(table, {
      episode_id: "B1",
      recipe_id: "minimal-v1",
      family_id: "fam-syn-p1",
      fixture_ref: pairFixture("fam-syn-p1", "v1"),
    }),
    failEp({
      episode_id: "T1",
      recipe_id: "bounded_repair-v1",
      family_id: "fam-syn-p1",
      fixture_ref: pairFixture("fam-syn-p1", "v1"),
    }),
    failEp({
      episode_id: "B2",
      recipe_id: "minimal-v1",
      family_id: "fam-syn-p2",
      fixture_ref: pairFixture("fam-syn-p2", "v1"),
    }),
    solveEp(table, {
      episode_id: "T2",
      recipe_id: "bounded_repair-v1",
      family_id: "fam-syn-p2",
      fixture_ref: pairFixture("fam-syn-p2", "v1"),
    }),
    solveEp(table, {
      episode_id: "B3",
      recipe_id: "minimal-v1",
      family_id: "fam-syn-p3",
      fixture_ref: pairFixture("fam-syn-p3", "v1"),
    }),
    solveEp(table, {
      episode_id: "T3",
      recipe_id: "bounded_repair-v1",
      family_id: "fam-syn-p3",
      fixture_ref: pairFixture("fam-syn-p3", "v1"),
    }),
    makeEpisode({
      episode_id: "B4",
      recipe_id: "minimal-v1",
      family_id: "fam-syn-p4",
      fixture_ref: pairFixture("fam-syn-p4", "v1"),
    }),
    solveEp(table, {
      episode_id: "T4",
      recipe_id: "bounded_repair-v1",
      family_id: "fam-syn-p4",
      fixture_ref: pairFixture("fam-syn-p4", "v1"),
    }),
  ];
  const res = await comparePaired()(episodes, baseOpts({ verifier: fakeVerifier(table) }));
  expect(res.n_pairs).toBe(4);
  expect(res.discordant).toEqual({ baseline_only: 1, treatment_only: 1 });
  expect(res.baseline.s).toBe(2);
  expect(res.baseline.n).toBe(3);
  expect(res.baseline.n_unknown).toBe(1);
  expect(res.baseline.n_excluded).toBe(0);
  expect(res.baseline.rate).toBeCloseTo(2 / 3, 10);
  const wilson = res.baseline.wilson;
  expect(wilson).not.toBeNull();
  expect(wilson!.lo).toBeLessThan(2 / 3);
  expect(wilson!.hi).toBeGreaterThan(2 / 3);
  expect(res.treatment.s).toBe(3);
  expect(res.treatment.n).toBe(4);
});
