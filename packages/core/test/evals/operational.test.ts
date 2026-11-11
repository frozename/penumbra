import { beforeAll, expect, test } from "bun:test";

import { type Episode, EpisodeSchema } from "@src/evals/manifest.js";

type JsonObject = Record<string, unknown>;

// Input and output shapes are declared locally: operational.ts does not exist
// at the base, so no value or type may be imported from it.
type ContractFlagCount = { yes: number; no: number; unknown: number };
type TimingStat = { n: number; n_missing: number; sum: number; median: number | null };
type OperationalGroup = {
  key: string;
  n_episodes: number;
  n_attempts: number;
  outcomes: {
    model_failure: number;
    environment: number;
    baseline: number;
    resource: number;
    auth: number;
    blocked_correct: number;
    terminal_unverified: number;
    unknown: number;
  };
  terminal_completion: { n_terminal: number; n_unknown: number };
  artifact: { produced: number; absent: number; rate: number };
  final_commit: {
    model: number;
    recovery: number;
    unknown: number;
    human_takeover: number;
    no_attempts: number;
  };
  assistance: {
    recovery_autocommit: number;
    retry_child: number;
    chain_hop: number;
    fix_round: number;
    teacher: number;
    human_takeover: number;
    operator_note: number;
    assisted_episodes: number;
  };
  contract: {
    base_not_ancestor: ContractFlagCount;
    identity_mismatch: ContractFlagCount;
  };
  timings: {
    queue_ms: TimingStat;
    exec_ms: TimingStat;
    check_ms: TimingStat;
    e2e_ms: TimingStat;
  };
  cost_usd: { sum: number; n_missing: number; n_incomplete: number; complete: boolean };
};
type SummarizeResult = { groups: OperationalGroup[] };
type SummarizeFn = (episodes: readonly Episode[], opts: { groupBy: string }) => SummarizeResult;

const MOD_URL = new URL("../../src/evals/operational.ts", import.meta.url).href;

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

const summarizeOperational = (): SummarizeFn => mod?.["summarizeOperational"] as SummarizeFn;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const SHA_E = "e".repeat(40);
const HARNESS_SHA = "9".repeat(40);

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

function unknownCommits(): JsonObject {
  return {
    final_commit_attribution: "unknown",
    attribution_basis: "none",
    autocommit_flag: null,
  };
}

function recoveryCommits(): JsonObject {
  return {
    final_commit_attribution: "recovery",
    attribution_basis: "dispatch_end_autocommitted",
    autocommit_flag: true,
  };
}

function modelCommits(): JsonObject {
  return {
    final_commit_attribution: "model",
    attribution_basis: "controlled_harness_build",
    autocommit_flag: null,
  };
}

function contractFlags(
  baseNotAncestor: boolean | null,
  identityMismatch: boolean | null,
): JsonObject {
  return {
    scope: "attempt",
    source: "attempt_dispatch_end",
    base_not_ancestor: baseNotAncestor,
    identity_mismatch: identityMismatch,
  };
}

function e2eOnly(e2eMs: number | null): JsonObject {
  return { queue_ms: null, exec_ms: null, check_ms: null, e2e_ms: e2eMs };
}

function att(n: number, headSha: string | null, overrides: JsonObject = {}): JsonObject {
  return {
    n,
    handoff_id: `h${String(n)}`,
    dispatch_attempt: null,
    head_sha: headSha,
    commits: unknownCommits(),
    contract_flags: {
      scope: "attempt",
      source: "none",
      base_not_ancestor: null,
      identity_mismatch: null,
    },
    timings: { queue_ms: null, exec_ms: null, check_ms: null, e2e_ms: null },
    usage: { tokens: null, cost_usd: null, scope: "unknown", missing_reason: "x" },
    ...overrides,
  };
}

function attemptHistoryFor(attempts: readonly JsonObject[]): JsonObject {
  if (attempts.length === 0) {
    return {
      status: "unavailable",
      reason: "events_absent",
      count: null,
      count_basis: "unknown",
    };
  }
  const lastN: unknown = attempts[attempts.length - 1]?.["n"];
  return {
    status: "complete",
    reason: null,
    count: typeof lastN === "number" ? lastN : attempts.length,
    count_basis: "claim_events",
  };
}

function finalShaFor(attempts: readonly JsonObject[]): string | null {
  const head: unknown = attempts[attempts.length - 1]?.["head_sha"];
  return typeof head === "string" ? head : null;
}

function makeEpisode(overrides: JsonObject = {}): Episode {
  const attempts = (overrides["attempts"] as readonly JsonObject[] | undefined) ?? [att(1, SHA_A)];
  const episode: JsonObject = {
    schema_version: 1,
    episode_id: "e1",
    family_id: "fam-e1",
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
    attempt_history: attemptHistoryFor(attempts),
    attempts,
    assistance: [],
    final_sha: finalShaFor(attempts),
    receipts: [],
    observed_outcome: { class: "terminal_unverified" },
    handoff_reliability: null,
    lineage_usage: null,
    labels: {},
    ...overrides,
  };
  return EpisodeSchema.parse(episode);
}

function controlledEpisode(id: string, overrides: JsonObject = {}): Episode {
  const familyId = `fam-${id}`;
  return makeEpisode({
    episode_id: id,
    family_id: familyId,
    design: "controlled",
    fixture_ref: { family_id: familyId, variant_id: "v1" },
    harness_build: { sha: HARNESS_SHA },
    ...overrides,
  });
}

function envAuthOutcome(): JsonObject {
  return {
    class: "environment_failure",
    kind: "auth",
    env_evidence: {
      source: "grader_control_failed",
      ref: "evt-auth-1",
      observed_at: "2026-11-01T10:00:00Z",
      first_model_turn_at: null,
    },
  };
}

function outcomeFixture(): Episode[] {
  const blocked = makeEpisode({
    episode_id: "e-blocked",
    family_id: "fam-blocked",
    fixture_ref: { family_id: "fam-blocked", variant_id: "v1" },
    observed_outcome: { class: "blocked_correct", expectation_ref: "exp-1" },
  });
  return [
    makeEpisode({
      episode_id: "e-model",
      family_id: "fam-model",
      observed_outcome: { class: "model_failure", reason: "hidden_failed" },
    }),
    controlledEpisode("e-env", { observed_outcome: envAuthOutcome() }),
    blocked,
    makeEpisode({
      episode_id: "e-term",
      family_id: "fam-term",
      observed_outcome: { class: "terminal_unverified" },
    }),
    makeEpisode({
      episode_id: "e-unk",
      family_id: "fam-unk",
      observed_outcome: { class: "unknown", missing_reason: "events_lost" },
    }),
  ];
}

function lineageComplete(costUsd: number): JsonObject {
  return {
    tokens: 10,
    cost_usd: costUsd,
    handoff_ids_counted: 1,
    complete: true,
    incomplete_reason: null,
  };
}

function lineageIncomplete(costUsd: number | null): JsonObject {
  return {
    tokens: costUsd === null ? null : 10,
    cost_usd: costUsd,
    handoff_ids_counted: 1,
    complete: false,
    incomplete_reason: "handoff_usage_missing",
  };
}

test("1: groupBy recipe_id sorts groups ascending by key with null under none", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const eps = [
    controlledEpisode("e-a2", {
      recipe_id: "recipe-a",
      attempts: [att(1, SHA_B), att(2, SHA_C)],
    }),
    controlledEpisode("e-z", { recipe_id: "recipe-z", attempts: [att(1, SHA_D)] }),
    controlledEpisode("e-a1", { recipe_id: "recipe-a", attempts: [att(1, SHA_A)] }),
    makeEpisode({ episode_id: "e-none", family_id: "fam-none" }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups.map((group) => group.key)).toEqual(["none", "recipe-a", "recipe-z"]);
  const byKey = new Map(res.groups.map((group) => [group.key, group]));
  expect(byKey.get("none")?.n_episodes).toBe(1);
  expect(byKey.get("none")?.n_attempts).toBe(1);
  expect(byKey.get("recipe-a")?.n_episodes).toBe(2);
  expect(byKey.get("recipe-a")?.n_attempts).toBe(3);
  expect(byKey.get("recipe-z")?.n_episodes).toBe(1);
  expect(byKey.get("recipe-z")?.n_attempts).toBe(1);
});

test("2: an unsupported groupBy key throws", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const ep = makeEpisode({ episode_id: "e-g", family_id: "fam-g" });
  expect(() => summarizeOperational()([ep], { groupBy: "model" })).toThrow(
    /unsupported groupBy key/,
  );
});

test("3: outcomes counts each observed class and splits environment_failure by kind", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const res = summarizeOperational()(outcomeFixture(), { groupBy: "recipe_id" });
  expect(res.groups).toHaveLength(1);
  expect(res.groups[0]?.outcomes).toEqual({
    model_failure: 1,
    environment: 0,
    baseline: 0,
    resource: 0,
    auth: 1,
    blocked_correct: 1,
    terminal_unverified: 1,
    unknown: 1,
  });
});

test("4: terminal_completion counts every non-unknown outcome as terminal", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const res = summarizeOperational()(outcomeFixture(), { groupBy: "recipe_id" });
  expect(res.groups[0]?.terminal_completion).toEqual({
    n_terminal: 4,
    n_unknown: 1,
  });
});

test("5: artifact counts final_sha presence as produced and absent", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const eps = [
    makeEpisode({ episode_id: "e-p1", family_id: "fam-p1" }),
    makeEpisode({ episode_id: "e-p2", family_id: "fam-p2" }),
    makeEpisode({
      episode_id: "e-absent",
      family_id: "fam-absent",
      final_sha: null,
    }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.artifact).toEqual({ produced: 2, absent: 1, rate: 2 / 3 });
});

test("6: final_commit classifies each episode by its last attempt", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const recoveryEp = makeEpisode({
    episode_id: "e-rec",
    family_id: "fam-rec",
    attempts: [att(1, SHA_A), att(2, SHA_B, { commits: recoveryCommits() })],
  });
  const modelEp = controlledEpisode("e-fcmodel", {
    attempts: [att(1, SHA_C, { commits: modelCommits() })],
  });
  const emptyEp = makeEpisode({
    episode_id: "e-empty",
    family_id: "fam-empty",
    attempts: [],
  });
  const takeoverEp = makeEpisode({
    episode_id: "e-takeover",
    family_id: "fam-takeover",
    final_sha: SHA_E,
    attempts: [att(1, SHA_D)],
    assistance: [{ kind: "human_takeover", attempt_n: 1, ref: SHA_E }],
  });
  const res = summarizeOperational()([recoveryEp, modelEp, emptyEp, takeoverEp], {
    groupBy: "recipe_id",
  });
  expect(res.groups[0]?.final_commit).toEqual({
    model: 1,
    recovery: 1,
    unknown: 1,
    human_takeover: 1,
    no_attempts: 0,
  });
});

test("7: assistance counts episodes per kind, not entries", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const assisted1 = makeEpisode({
    episode_id: "e-ast1",
    family_id: "fam-ast1",
    attempts: [att(1, SHA_A), att(2, SHA_B)],
    assistance: [
      { kind: "fix_round", attempt_n: 1, ref: null },
      { kind: "fix_round", attempt_n: 2, ref: null },
      { kind: "teacher", attempt_n: 1, ref: null },
    ],
  });
  const assisted2 = makeEpisode({
    episode_id: "e-ast2",
    family_id: "fam-ast2",
    assistance: [{ kind: "fix_round", attempt_n: 1, ref: null }],
  });
  const plain = makeEpisode({ episode_id: "e-ast3", family_id: "fam-ast3" });
  const res = summarizeOperational()([assisted1, assisted2, plain], {
    groupBy: "recipe_id",
  });
  expect(res.groups[0]?.assistance).toEqual({
    recovery_autocommit: 0,
    retry_child: 0,
    chain_hop: 0,
    fix_round: 2,
    teacher: 1,
    human_takeover: 0,
    operator_note: 0,
    assisted_episodes: 2,
  });
});

test("8: contract flags count per attempt with null reported as unknown", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const ep1 = makeEpisode({
    episode_id: "e-c1",
    family_id: "fam-c1",
    attempts: [
      att(1, SHA_A, { contract_flags: contractFlags(true, true) }),
      att(2, SHA_B, { contract_flags: contractFlags(false, null) }),
    ],
  });
  const ep2 = makeEpisode({
    episode_id: "e-c2",
    family_id: "fam-c2",
    attempts: [att(1, SHA_C, { contract_flags: contractFlags(null, null) })],
  });
  const res = summarizeOperational()([ep1, ep2], { groupBy: "recipe_id" });
  expect(res.groups[0]?.contract).toEqual({
    base_not_ancestor: { yes: 1, no: 1, unknown: 1 },
    identity_mismatch: { yes: 1, no: 0, unknown: 2 },
  });
});

test("9: timings sum per episode across attempts and report honest missingness", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const eps = [
    makeEpisode({
      episode_id: "e-tA",
      family_id: "fam-tA",
      attempts: [att(1, SHA_A, { timings: e2eOnly(100) }), att(2, SHA_B, { timings: e2eOnly(50) })],
    }),
    makeEpisode({
      episode_id: "e-tB",
      family_id: "fam-tB",
      attempts: [att(1, SHA_C, { timings: e2eOnly(30) })],
    }),
    makeEpisode({
      episode_id: "e-tC",
      family_id: "fam-tC",
      attempts: [att(1, SHA_D, { timings: e2eOnly(null) })],
    }),
    makeEpisode({ episode_id: "e-tD", family_id: "fam-tD", attempts: [] }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  const timings = res.groups[0]?.timings;
  expect(timings?.e2e_ms).toEqual({ n: 2, n_missing: 2, sum: 180, median: 90 });
  expect(timings?.queue_ms).toEqual({ n: 0, n_missing: 4, sum: 0, median: null });
  expect(timings?.exec_ms).toEqual({ n: 0, n_missing: 4, sum: 0, median: null });
  expect(timings?.check_ms).toEqual({ n: 0, n_missing: 4, sum: 0, median: null });
});

test("9b: timings median takes the middle value for an odd count", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const eps = [10, 20, 70].map((ms, index) =>
    makeEpisode({
      episode_id: `e-med${String(index)}`,
      family_id: `fam-med${String(index)}`,
      attempts: [att(1, SHA_A, { timings: e2eOnly(ms) })],
    }),
  );
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.timings.e2e_ms).toEqual({
    n: 3,
    n_missing: 0,
    sum: 100,
    median: 20,
  });
});

test("10: cost_usd mirrors lineage usage with missingness and completeness", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const eps = [
    makeEpisode({
      episode_id: "e-u1",
      family_id: "fam-u1",
      lineage_usage: lineageComplete(1.5),
    }),
    makeEpisode({
      episode_id: "e-u2",
      family_id: "fam-u2",
      lineage_usage: lineageIncomplete(0.5),
    }),
    makeEpisode({
      episode_id: "e-u3",
      family_id: "fam-u3",
      lineage_usage: lineageIncomplete(null),
    }),
    makeEpisode({ episode_id: "e-u4", family_id: "fam-u4" }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.cost_usd).toEqual({
    sum: 2,
    n_missing: 2,
    n_incomplete: 1,
    complete: false,
  });
});

test("10b: cost_usd reports complete when every episode has full usage", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const eps = [
    makeEpisode({
      episode_id: "e-k1",
      family_id: "fam-k1",
      lineage_usage: lineageComplete(0.25),
    }),
    makeEpisode({
      episode_id: "e-k2",
      family_id: "fam-k2",
      lineage_usage: lineageComplete(0.75),
    }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.cost_usd).toEqual({
    sum: 1,
    n_missing: 0,
    n_incomplete: 0,
    complete: true,
  });
});

test("11: group output is deterministic under input reordering", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const eps = [
    controlledEpisode("e-d1", {
      recipe_id: "recipe-a",
      attempts: [att(1, SHA_A), att(2, SHA_B, { commits: recoveryCommits() })],
    }),
    makeEpisode({
      episode_id: "e-d2",
      family_id: "fam-d2",
      observed_outcome: { class: "unknown", missing_reason: "events_lost" },
    }),
    controlledEpisode("e-d3", { recipe_id: "recipe-b", attempts: [] }),
    makeEpisode({
      episode_id: "e-d4",
      family_id: "fam-d4",
      attempts: [att(1, SHA_C, { timings: e2eOnly(40) })],
      assistance: [{ kind: "fix_round", attempt_n: 1, ref: null }],
      lineage_usage: lineageComplete(0.5),
    }),
  ];
  const forward = summarizeOperational()(eps, { groupBy: "recipe_id" });
  const reversed = summarizeOperational()([...eps].reverse(), { groupBy: "recipe_id" });
  expect(reversed.groups).toEqual(forward.groups);
});

test("12: partial attempt_history reports n_attempts from count and null timings", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const partialHistory: JsonObject = {
    status: "partial",
    reason: "claims_pruned",
    count: 10,
    count_basis: "handoff_counter",
  };
  const eps = [
    controlledEpisode("e-partial", {
      recipe_id: "recipe-partial",
      attempts: [att(8, SHA_A), att(9, SHA_B), att(10, SHA_C, { commits: recoveryCommits() })],
      attempt_history: partialHistory,
    }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.n_attempts).toBe(10);
  expect(res.groups[0]?.timings.e2e_ms.n_missing).toBe(1);
  expect(res.groups[0]?.timings.e2e_ms.n).toBe(0);
  expect(res.groups[0]?.final_commit.recovery).toBe(1);
  expect(res.groups[0]?.final_commit.unknown).toBe(0);
});

test("13: unavailable attempt_history with count > 0 reports final_commit unknown", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const unavailableHistory: JsonObject = {
    status: "unavailable",
    reason: "events_absent",
    count: 5,
    count_basis: "unknown",
  };
  const eps = [
    controlledEpisode("e-unavail", {
      recipe_id: "recipe-unavail",
      attempts: [],
      attempt_history: unavailableHistory,
    }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.final_commit.no_attempts).toBe(0);
  expect(res.groups[0]?.final_commit.unknown).toBe(1);
  expect(res.groups[0]?.n_attempts).toBe(5);
});

test("14: unavailable attempt_history with count 0 reports no_attempts", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const unavailableHistory: JsonObject = {
    status: "unavailable",
    reason: "events_absent",
    count: 0,
    count_basis: "unknown",
  };
  const eps = [
    controlledEpisode("e-unavail0", {
      recipe_id: "recipe-unavail0",
      attempts: [],
      attempt_history: unavailableHistory,
    }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.final_commit.no_attempts).toBe(1);
  expect(res.groups[0]?.final_commit.unknown).toBe(0);
  expect(res.groups[0]?.n_attempts).toBe(0);
});

test("15: unavailable attempt_history with count null reports unknown final_commit", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const unavailableHistory: JsonObject = {
    status: "unavailable",
    reason: "events_absent",
    count: null,
    count_basis: "unknown",
  };
  const eps = [
    controlledEpisode("e-unavailnull", {
      recipe_id: "recipe-unavailnull",
      attempts: [],
      attempt_history: unavailableHistory,
    }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.final_commit.no_attempts).toBe(0);
  expect(res.groups[0]?.final_commit.unknown).toBe(1);
  expect(res.groups[0]?.n_attempts).toBe(0);
});

test("16: takeover with ref !== final_sha is not counted as human_takeover", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const eps = [
    controlledEpisode("e-takeover-mismatch", {
      recipe_id: "recipe-takeover-mismatch",
      final_sha: SHA_E,
      attempts: [att(1, SHA_A), att(2, SHA_E, { commits: modelCommits() })],
      assistance: [{ kind: "human_takeover", attempt_n: 1, ref: SHA_C }],
    }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.final_commit.human_takeover).toBe(0);
  expect(res.groups[0]?.final_commit.model).toBe(1);
});

test("17: terminal_completion counts n_terminal and n_unknown", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const eps = [
    controlledEpisode("e-term1", {
      recipe_id: "recipe-term",
      observed_outcome: { class: "terminal_unverified" },
    }),
    controlledEpisode("e-unk1", {
      recipe_id: "recipe-term",
      observed_outcome: { class: "unknown", missing_reason: "events_lost" },
    }),
    controlledEpisode("e-unk2", {
      recipe_id: "recipe-term",
      observed_outcome: { class: "unknown", missing_reason: "events_lost" },
    }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.terminal_completion.n_terminal).toBe(1);
  expect(res.groups[0]?.terminal_completion.n_unknown).toBe(2);
});

test("18: terminal_completion when all episodes are unknown", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const eps = [
    controlledEpisode("e-allunk1", {
      recipe_id: "recipe-allunk",
      observed_outcome: { class: "unknown", missing_reason: "events_lost" },
    }),
    controlledEpisode("e-allunk2", {
      recipe_id: "recipe-allunk",
      observed_outcome: { class: "unknown", missing_reason: "events_lost" },
    }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.terminal_completion.n_terminal).toBe(0);
  expect(res.groups[0]?.terminal_completion.n_unknown).toBe(2);
});

test("19: partial/unavailable attempt_history forces null timings even with attempts", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const partialHistory: JsonObject = {
    status: "partial",
    reason: "claims_pruned",
    count: 3,
    count_basis: "handoff_counter",
  };
  const eps = [
    controlledEpisode("e-partial-timing", {
      recipe_id: "recipe-partial-timing",
      attempts: [
        att(2, SHA_A, { timings: e2eOnly(100) }),
        att(3, SHA_B, { timings: e2eOnly(200) }),
      ],
      attempt_history: partialHistory,
    }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.timings.e2e_ms.n).toBe(0);
  expect(res.groups[0]?.timings.e2e_ms.n_missing).toBe(1);
});

test("20: median computed on sorted values [70,10,20] returns 20", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const eps = [70, 10, 20].map((ms, index) =>
    makeEpisode({
      episode_id: `e-med-${String(index)}`,
      family_id: `fam-med-${String(index)}`,
      attempts: [att(1, SHA_A, { timings: e2eOnly(ms) })],
    }),
  );
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.timings.e2e_ms.median).toBe(20);
});

test("21: cost_usd complete is false when nIncomplete > 0 despite nMissing === 0", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const eps = [
    makeEpisode({
      episode_id: "e-complete-partial",
      family_id: "fam-complete-partial",
      lineage_usage: lineageIncomplete(0.5),
    }),
  ];
  const res = summarizeOperational()(eps, { groupBy: "recipe_id" });
  expect(res.groups[0]?.cost_usd.n_missing).toBe(0);
  expect(res.groups[0]?.cost_usd.n_incomplete).toBe(1);
  expect(res.groups[0]?.cost_usd.complete).toBe(false);
});

test("22: partial attempt_history pruned attempts count as unknown in contract flags", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const partialHistory: JsonObject = {
    status: "partial",
    reason: "claims_pruned",
    count: 5,
    count_basis: "handoff_counter",
  };
  const ep = makeEpisode({
    episode_id: "e-contract-pruned",
    family_id: "fam-contract-pruned",
    attempts: [
      att(4, SHA_A, { contract_flags: contractFlags(true, false) }),
      att(5, SHA_B, { contract_flags: contractFlags(false, true) }),
    ],
    attempt_history: partialHistory,
  });
  const res = summarizeOperational()([ep], { groupBy: "recipe_id" });
  const base = res.groups[0]?.contract.base_not_ancestor;
  const identity = res.groups[0]?.contract.identity_mismatch;
  expect(base?.yes).toBe(1);
  expect(base?.no).toBe(1);
  expect(base?.unknown).toBe(3);
  expect(identity?.yes).toBe(1);
  expect(identity?.no).toBe(1);
  expect(identity?.unknown).toBe(3);
});

test("23: unavailable attempt_history with count > 0 pruned attempts count as unknown in contract flags", () => {
  expect(typeof mod?.["summarizeOperational"]).toBe("function");
  const unavailableHistory: JsonObject = {
    status: "unavailable",
    reason: "events_absent",
    count: 5,
    count_basis: "unknown",
  };
  const ep = makeEpisode({
    episode_id: "e-unavail-contract",
    family_id: "fam-unavail-contract",
    attempts: [],
    attempt_history: unavailableHistory,
  });
  const res = summarizeOperational()([ep], { groupBy: "recipe_id" });
  const base = res.groups[0]?.contract.base_not_ancestor;
  const identity = res.groups[0]?.contract.identity_mismatch;
  expect(base?.unknown).toBe(5);
  expect(identity?.unknown).toBe(5);
});
