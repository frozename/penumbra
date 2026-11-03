import { LaneCloseMetadataSchema } from "@penumbra/api-contract";
import { expect, test } from "bun:test";

import {
  AGENT_PERFORMANCE_RESERVED_METADATA_KEYS,
  FULL_GIT_SHA_RE,
} from "@src/schemas/agent-performance.js";

type JsonObject = Record<string, unknown>;

interface SchemaLike {
  safeParse: (value: unknown) => { success: boolean };
}

interface ReceiptClaimSchemaLike extends SchemaLike {
  shape: { fail_reason: { unwrap: () => { options: readonly string[] } } };
}

interface RecipeSchemaLike extends SchemaLike {
  shape: { arms: { element: { options: readonly string[] } } };
}

interface ManifestModule {
  EpisodeSchema: SchemaLike;
  GitShaSchema: SchemaLike;
  LineageUsageSchema: SchemaLike;
  ModelIdentitySchema: SchemaLike;
  ObservedOutcomeSchema: SchemaLike;
  ReceiptClaimSchema: ReceiptClaimSchemaLike;
  RecipeSchema: RecipeSchemaLike;
  UsageSchema: SchemaLike;
  receiptDigest: (receipt: JsonObject) => string;
}

const SHA40 = "a".repeat(40);
const SHA40_B = "b".repeat(40);
const HEX64_1 = "1".repeat(64);
const HEX64_2 = "2".repeat(64);
const HEX64_C = "c".repeat(64);

// The evals module does not exist yet. Keeping the specifier non-literal
// leaves the import unresolved for tsc (no TS2307), and `.catch` keeps a
// missing module a failed assertion, never a load error.
const EVALS_MODULE = ["@src", "evals", "manifest.js"].join("/");

function parses(schema: SchemaLike, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(true);
}

function rejects(schema: SchemaLike, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

function modelIdentity(overrides: JsonObject = {}): JsonObject {
  return {
    declared: { value: null, provenance: "unknown", missing_reason: "x" },
    effective: { value: null, provenance: "unknown", missing_reason: "x" },
    provider: { value: null, provenance: "unknown", missing_reason: "x" },
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

function epControlled(overrides: JsonObject = {}): JsonObject {
  return ep({
    design: "controlled",
    family_id: "fam-syn-a",
    fixture_ref: { family_id: "fam-syn-a", variant_id: "v" },
    lineage: { root_handoff_id: null, handoff_ids: [], shape: "fixture" },
    attempt_history: history("complete", null, 1, "fixture_replay"),
    attempts: [att(1, SHA40)],
    final_sha: SHA40,
    ...overrides,
  });
}

function att(n: number, headSha: string | null, overrides: JsonObject = {}): JsonObject {
  return {
    n,
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
    started_at: null,
    first_model_turn_at: null,
    ended_at: null,
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

function out(overrides: JsonObject = {}): JsonObject {
  return {
    class: "unknown",
    reason: null,
    missing_reason: "x",
    expectation_ref: null,
    env_evidence: null,
    ...overrides,
  };
}

function envEvidence(overrides: JsonObject = {}): JsonObject {
  return {
    source: "dispatch_failure_class",
    observed_at: "2026-11-01T10:00:00Z",
    first_model_turn_at: null,
    ...overrides,
  };
}

function commits(attribution: string, basis: string, flag: boolean | null): JsonObject {
  return {
    final_commit_attribution: attribution,
    attribution_basis: basis,
    autocommit_flag: flag,
  };
}

function hiddenReceiptBody(): JsonObject {
  return {
    kind: "hidden_assertion",
    sha: SHA40,
    producer: "grader",
    claimed_verdict: "fail",
    fail_reason: "hidden_failed",
    assertion_set_digest: HEX64_1,
    grader_build: HEX64_2,
    per_check: [
      { id: "c1", ok: true },
      { id: "c2", ok: false },
    ],
    control_verdict: "pass",
    receipt_digest: null,
  };
}

function signReceipt(mod: ManifestModule, receipt: JsonObject): JsonObject {
  const unsigned = { ...receipt, receipt_digest: null };
  return { ...unsigned, receipt_digest: mod.receiptDigest(unsigned) };
}

test("case 1: ModelIdentity effective accepts unknown provenance, rejects invalid shapes", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  parses(
    mod.ModelIdentitySchema,
    modelIdentity({
      effective: {
        value: null,
        provenance: "unknown",
        missing_reason: "no_acp_model_event",
      },
    }),
  );
  rejects(mod.ModelIdentitySchema, modelIdentity({ effective: { value: null } }));
  rejects(
    mod.ModelIdentitySchema,
    modelIdentity({ effective: { value: "qwen3", provenance: "unattested" } }),
  );
  rejects(
    mod.ModelIdentitySchema,
    modelIdentity({
      effective: { value: "x", provenance: "declared", missing_reason: null },
    }),
  );
});

test("case 2: ModelIdentity is strict and provenance is a closed enum", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(mod.ModelIdentitySchema, modelIdentity({ weights_sha256: HEX64_C }));
  rejects(
    mod.ModelIdentitySchema,
    modelIdentity({
      declared: { value: "m", provenance: "hashed_at_dispatch", missing_reason: null },
    }),
  );
});

test("case 3: GitShaSchema accepts 40/64 lowercase hex matching FULL_GIT_SHA_RE", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(mod.GitShaSchema, "abc1234");
  rejects(mod.GitShaSchema, "A".repeat(40));
  parses(mod.GitShaSchema, "a".repeat(40));
  parses(mod.GitShaSchema, "b".repeat(64));
  for (const s of ["a".repeat(40), "b".repeat(64), "abc1234", "A".repeat(40), "g".repeat(41)]) {
    expect(mod.GitShaSchema.safeParse(s).success).toBe(FULL_GIT_SHA_RE.test(s));
  }
});

test("case 4: ReceiptClaim rejects extra keys and lane_gate sha", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  const laneGate = {
    kind: "lane_gate",
    sha: null,
    producer: "lane",
    claimed_verdict: "pass",
    fail_reason: null,
    assertion_set_digest: null,
    grader_build: null,
    per_check: null,
    control_verdict: null,
    receipt_digest: null,
  };
  parses(mod.ReceiptClaimSchema, laneGate);
  for (const key of ["independent", "verified", "verification"]) {
    rejects(mod.ReceiptClaimSchema, { ...laneGate, [key]: true });
  }
  rejects(mod.ReceiptClaimSchema, { ...laneGate, sha: SHA40 });
  expect(LaneCloseMetadataSchema.safeParse({ head_sha: SHA40 }).success).toBe(false);
});

test("case 5: grader-shaped receipt round-trips through receiptDigest", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  const body = hiddenReceiptBody();
  body["receipt_digest"] = mod.receiptDigest(body);
  parses(mod.ReceiptClaimSchema, body);
  rejects(mod.ReceiptClaimSchema, signReceipt(mod, { ...hiddenReceiptBody(), verdict: "fail" }));
  rejects(
    mod.ReceiptClaimSchema,
    signReceipt(mod, { ...hiddenReceiptBody(), control: { verdict: "pass" } }),
  );
  rejects(
    mod.ReceiptClaimSchema,
    signReceipt(mod, {
      ...hiddenReceiptBody(),
      per_check: [{ id: "c1", ok: true, expect: {} }],
    }),
  );
  rejects(
    mod.ReceiptClaimSchema,
    signReceipt(mod, {
      ...hiddenReceiptBody(),
      per_check: [{ id: "attempt_reset", ok: true }],
    }),
  );
});

test("case 6: hidden_assertion receipt semantic guards", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  const signed = signReceipt(mod, hiddenReceiptBody());
  rejects(mod.ReceiptClaimSchema, { ...signed, claimed_verdict: "pass" });
  rejects(mod.ReceiptClaimSchema, signReceipt(mod, { ...hiddenReceiptBody(), grader_build: null }));
  rejects(mod.ReceiptClaimSchema, signReceipt(mod, { ...hiddenReceiptBody(), producer: "worker" }));
  rejects(
    mod.ReceiptClaimSchema,
    signReceipt(mod, { ...hiddenReceiptBody(), control_verdict: "fail" }),
  );
  rejects(
    mod.ReceiptClaimSchema,
    signReceipt(mod, {
      ...hiddenReceiptBody(),
      claimed_verdict: "pass",
      per_check: [
        { id: "c1", ok: true },
        { id: "c2", ok: true },
      ],
    }),
  );
  rejects(
    mod.ReceiptClaimSchema,
    signReceipt(mod, {
      ...hiddenReceiptBody(),
      claimed_verdict: "pass",
      fail_reason: null,
    }),
  );
  rejects(
    mod.ReceiptClaimSchema,
    signReceipt(mod, {
      ...hiddenReceiptBody(),
      per_check: [
        { id: "c1", ok: true },
        { id: "c1", ok: false },
      ],
    }),
  );
});

test("case 7: observed_outcome class and expectation_ref rules", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  for (const cls of ["solved_verified", "solved_unverified", "blocked_incorrect"]) {
    rejects(mod.ObservedOutcomeSchema, out({ class: cls }));
  }
  parses(
    mod.ObservedOutcomeSchema,
    out({ class: "model_failure", reason: "incorrect_blocked", missing_reason: null }),
  );
  rejects(mod.ObservedOutcomeSchema, out({ class: "blocked_correct", missing_reason: null }));
});

test("case 8: environment_failure needs env_evidence; worktree_setup_failed ordering", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(
    mod.ObservedOutcomeSchema,
    out({
      class: "environment_failure",
      reason: "worktree_setup_failed",
      missing_reason: null,
    }),
  );
  for (const reason of ["candidate_timeout", "base_not_ancestor", "contract_violation"]) {
    parses(
      mod.ObservedOutcomeSchema,
      out({ class: "model_failure", reason, missing_reason: null }),
    );
  }
  rejects(mod.ObservedOutcomeSchema, out({ class: "unknown", missing_reason: null }));
  const wsf = {
    class: "environment_failure",
    reason: "worktree_setup_failed",
    missing_reason: null,
  };
  rejects(
    mod.ObservedOutcomeSchema,
    out({ ...wsf, env_evidence: envEvidence({ observed_at: null }) }),
  );
  rejects(
    mod.ObservedOutcomeSchema,
    out({
      ...wsf,
      env_evidence: envEvidence({
        observed_at: "2026-11-01T10:00:05Z",
        first_model_turn_at: "2026-11-01T10:00:01Z",
      }),
    }),
  );
  parses(
    mod.ObservedOutcomeSchema,
    out({
      ...wsf,
      env_evidence: envEvidence({
        observed_at: "2026-11-01T10:00:01Z",
        first_model_turn_at: "2026-11-01T10:00:05Z",
      }),
    }),
  );
  parses(
    mod.ObservedOutcomeSchema,
    out({ ...wsf, env_evidence: envEvidence({ observed_at: "2026-11-01T10:00:01Z" }) }),
  );
});

test("case 9: dispatch_failure_class env source is invalid for controlled episodes", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  const envFail = (source: string): JsonObject =>
    out({
      class: "environment_failure",
      reason: "worktree_setup_failed",
      missing_reason: null,
      env_evidence: envEvidence({ source }),
    });
  rejects(mod.EpisodeSchema, epControlled({ observed_outcome: envFail("dispatch_failure_class") }));
  parses(mod.EpisodeSchema, ep({ observed_outcome: envFail("dispatch_failure_class") }));
  parses(mod.EpisodeSchema, epControlled({ observed_outcome: envFail("grader_control_failed") }));
});

test("case 10: commit attribution and autocommit_flag rules", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  const obsWithAttempt = (commitsField: JsonObject): JsonObject =>
    ep({
      attempt_history: history("complete", null, 1, "claim_events"),
      attempts: [att(1, SHA40, { commits: commitsField })],
      final_sha: SHA40,
    });
  rejects(mod.EpisodeSchema, obsWithAttempt(commits("unknown", "none", false)));
  rejects(mod.EpisodeSchema, obsWithAttempt(commits("recovery", "none", null)));
  rejects(mod.EpisodeSchema, obsWithAttempt(commits("model", "none", null)));
  parses(
    mod.EpisodeSchema,
    epControlled({
      harness_build: { sha: HEX64_C, missing_reason: null },
      attempts: [att(1, SHA40, { commits: commits("model", "controlled_harness_build", null) })],
    }),
  );
});

test("case 11: scope fields pin contract_flags/handoff_reliability/usage", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(
    mod.EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 1, "claim_events"),
      attempts: [
        att(1, SHA40, {
          contract_flags: {
            scope: "handoff",
            source: "none",
            base_not_ancestor: null,
            identity_mismatch: null,
          },
        }),
      ],
      final_sha: SHA40,
    }),
  );
  rejects(
    mod.EpisodeSchema,
    ep({
      handoff_reliability: {
        scope: "attempt",
        status: "complete",
        recommended_action: "accept",
      },
    }),
  );
  rejects(
    mod.EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 1, "claim_events"),
      attempts: [
        att(1, SHA40, {
          usage: {
            tokens: null,
            cost_usd: null,
            scope: "handoff_lineage",
            missing_reason: "x",
          },
        }),
      ],
      final_sha: SHA40,
    }),
  );
});

test("case 12: attempt_history status/count rules vs attempts", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(
    mod.EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 1, "claim_events"),
      attempts: [att(0, SHA40)],
      final_sha: SHA40,
    }),
  );
  rejects(
    mod.EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 3, "claim_events"),
      attempts: [att(1, SHA40), att(3, SHA40)],
      final_sha: SHA40,
    }),
  );
  rejects(
    mod.EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 1, "claim_events"),
      attempts: [att(2, SHA40)],
      final_sha: SHA40,
    }),
  );
  parses(
    mod.EpisodeSchema,
    ep({
      attempt_history: history("partial", "claims_pruned", 2, "handoff_counter"),
      attempts: [att(2, SHA40)],
      final_sha: SHA40,
    }),
  );
  rejects(
    mod.EpisodeSchema,
    ep({
      attempt_history: history("partial", "claims_pruned", 2, "handoff_counter"),
      attempts: [att(1, SHA40)],
      final_sha: SHA40,
    }),
  );
  rejects(
    mod.EpisodeSchema,
    ep({
      attempt_history: history("partial", "claims_pruned", 3, "handoff_counter"),
      attempts: [att(2, SHA40)],
      final_sha: SHA40,
    }),
  );
  rejects(
    mod.EpisodeSchema,
    ep({ attempt_history: history("unavailable", "events_absent", null, "claim_events") }),
  );
  parses(
    mod.EpisodeSchema,
    ep({
      attempt_history: history("unavailable", "retention_window", 2, "handoff_counter_lower_bound"),
    }),
  );
  rejects(
    mod.EpisodeSchema,
    ep({
      attempt_history: history("unavailable", "retention_window", 2, "handoff_counter_lower_bound"),
      attempts: [att(1, SHA40)],
      final_sha: SHA40,
    }),
  );
});

test("case 13: lineage_usage completeness and attempt usage missing_reason", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(mod.LineageUsageSchema, {
    tokens: null,
    cost_usd: null,
    handoff_ids_counted: 0,
    complete: true,
    incomplete_reason: null,
  });
  rejects(mod.LineageUsageSchema, {
    tokens: 120,
    cost_usd: null,
    handoff_ids_counted: 3,
    complete: false,
    incomplete_reason: null,
  });
  parses(mod.LineageUsageSchema, {
    tokens: 120,
    cost_usd: null,
    handoff_ids_counted: 3,
    complete: false,
    incomplete_reason: "t0_retention_window",
  });
  rejects(mod.UsageSchema, {
    tokens: null,
    cost_usd: null,
    scope: "attempt",
    missing_reason: null,
  });
  parses(mod.UsageSchema, {
    tokens: 0,
    cost_usd: null,
    scope: "attempt",
    missing_reason: null,
  });
});

test("case 14: episode strictness, recipe/fixture coupling, task_digest hex", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(mod.EpisodeSchema, ep({ recipe_id: "r1" }));
  rejects(mod.EpisodeSchema, ep({ hidden_assertions: [] }));
  rejects(mod.EpisodeSchema, ep({ hidden_assertions_ref: "x" }));
  rejects(mod.EpisodeSchema, epControlled({ family_id: "fam-syn-b" }));
  rejects(mod.EpisodeSchema, epControlled({ fixture_ref: null }));
  rejects(mod.EpisodeSchema, ep({ task_digest: "xyz" }));
});

test("case 15: labels reject agent_performance reserved metadata keys", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  for (const key of AGENT_PERFORMANCE_RESERVED_METADATA_KEYS) {
    rejects(mod.EpisodeSchema, ep({ labels: { [key]: "x" } }));
  }
});

test("case 16: RecipeSchema arm enum is closed; pending_upstream and limits guards", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  const recipe = {
    recipe_id: "r1",
    status: "ready",
    blocked_on: null,
    notes: null,
    arms: ["minimal"],
    limits: { max_rounds: 2 },
  };
  parses(mod.RecipeSchema, recipe);
  expect([...mod.RecipeSchema.shape.arms.element.options].sort()).toEqual([
    "bounded_repair",
    "capsule",
    "minimal",
    "verified_memory",
  ]);
  rejects(mod.RecipeSchema, { ...recipe, status: "pending_upstream" });
  rejects(mod.RecipeSchema, { ...recipe, status: "pending_upstream", blocked_on: "392" });
  rejects(mod.RecipeSchema, { ...recipe, limits: { max_rounds: 0 } });
});

test("case 28: fail_reason nondeterministic is a first-class receipt outcome", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  parses(
    mod.ReceiptClaimSchema,
    signReceipt(mod, { ...hiddenReceiptBody(), fail_reason: "nondeterministic" }),
  );
  parses(
    mod.ObservedOutcomeSchema,
    out({ class: "model_failure", reason: "nondeterministic", missing_reason: null }),
  );
  const options = mod.ReceiptClaimSchema.shape.fail_reason.unwrap().options;
  expect(options.filter((o) => o === "nondeterministic")).toHaveLength(1);
  rejects(
    mod.ReceiptClaimSchema,
    signReceipt(mod, {
      ...hiddenReceiptBody(),
      claimed_verdict: "pass",
      fail_reason: "nondeterministic",
      per_check: [
        { id: "c1", ok: true },
        { id: "c2", ok: true },
      ],
    }),
  );
});

test("case 29: final_sha must be explained by last attempt head or human_takeover", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  const hist = history("complete", null, 1, "claim_events");
  rejects(
    mod.EpisodeSchema,
    ep({ final_sha: SHA40, attempts: [att(1, SHA40_B)], attempt_history: hist }),
  );
  parses(
    mod.EpisodeSchema,
    ep({ final_sha: SHA40, attempts: [att(1, SHA40)], attempt_history: hist }),
  );
  rejects(mod.EpisodeSchema, ep({ final_sha: SHA40 }));
  parses(
    mod.EpisodeSchema,
    ep({
      final_sha: SHA40,
      attempts: [att(1, SHA40_B)],
      attempt_history: hist,
      assistance: [{ kind: "human_takeover", ref: SHA40 }],
    }),
  );
  rejects(
    mod.EpisodeSchema,
    ep({
      final_sha: SHA40,
      attempts: [att(1, SHA40_B)],
      attempt_history: hist,
      assistance: [{ kind: "operator_note", ref: SHA40 }],
    }),
  );
  rejects(
    mod.EpisodeSchema,
    ep({
      final_sha: SHA40,
      attempts: [att(1, SHA40), att(2, null)],
      attempt_history: history("complete", null, 2, "claim_events"),
    }),
  );
  parses(
    mod.EpisodeSchema,
    ep({ final_sha: null, attempts: [att(1, SHA40_B)], attempt_history: hist }),
  );
});

test("case 30: blocked_correct requires expectation_ref and a fixture_ref", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  const blocked = out({
    class: "blocked_correct",
    missing_reason: null,
    expectation_ref: "exp-1",
  });
  rejects(mod.EpisodeSchema, ep({ observed_outcome: blocked }));
  parses(mod.EpisodeSchema, epControlled({ observed_outcome: blocked }));
});

test("case 33: task_refs issues sorted/unique/positive, bundle_ids lowercase", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  parses(mod.EpisodeSchema, ep({ task_refs: { issues: [390], bundle_ids: ["op-x1"] } }));
  rejects(mod.EpisodeSchema, ep({ task_refs: { issues: [400, 390], bundle_ids: [] } }));
  rejects(mod.EpisodeSchema, ep({ task_refs: { issues: [390, 390], bundle_ids: [] } }));
  rejects(mod.EpisodeSchema, ep({ task_refs: { issues: [0], bundle_ids: [] } }));
  rejects(mod.EpisodeSchema, ep({ task_refs: undefined }));
  rejects(mod.EpisodeSchema, ep({ task_refs: { issues: [], bundle_ids: ["OP"] } }));
});

test("case 34: controlled fixture replay shape", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as ManifestModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  parses(mod.EpisodeSchema, epControlled());
  rejects(
    mod.EpisodeSchema,
    ep({
      lineage: { root_handoff_id: null, handoff_ids: [], shape: "fixture" },
      attempt_history: history("complete", null, 1, "fixture_replay"),
      attempts: [att(1, SHA40)],
      final_sha: SHA40,
    }),
  );
  rejects(
    mod.EpisodeSchema,
    epControlled({ lineage: { root_handoff_id: null, handoff_ids: [], shape: "single" } }),
  );
  rejects(
    mod.EpisodeSchema,
    epControlled({ attempt_history: history("complete", null, 1, "claim_events") }),
  );
});
