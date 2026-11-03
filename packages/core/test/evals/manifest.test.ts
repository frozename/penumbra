import { LaneCloseMetadataSchema } from "@penumbra/api-contract";
import { expect, test } from "bun:test";

import { digestOf } from "@src/evals/canonical.js";
import {
  AssistanceSchema,
  AttemptHistorySchema,
  AttemptSchema,
  EnvEvidenceSchema,
  EpisodeSchema,
  FixtureRefSchema,
  GitShaSchema,
  IsoTsSchema,
  LineageUsageSchema,
  ModelIdentitySchema,
  ObservedOutcomeSchema,
  type ReceiptClaimBody,
  ReceiptClaimSchema,
  receiptDigest,
  RecipeArmSchema,
  RecipeSchema,
  UsageSchema,
} from "@src/evals/manifest.js";
import {
  AGENT_PERFORMANCE_RESERVED_METADATA_KEYS,
  FULL_GIT_SHA_RE,
} from "@src/schemas/agent-performance.js";

type JsonObject = Record<string, unknown>;

interface SchemaLike {
  safeParse: (value: unknown) => { success: boolean };
}

const SHA40 = "a".repeat(40);
const SHA40_B = "b".repeat(40);
const HEX64_1 = "1".repeat(64);
const HEX64_2 = "2".repeat(64);
const HEX64_C = "c".repeat(64);

function parses(schema: SchemaLike, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(true);
}

function rejects(schema: SchemaLike, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

function omit(obj: JsonObject, key: string): JsonObject {
  const { [key]: _removed, ...rest } = obj;
  return rest;
}

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

function out(overrides: JsonObject = {}): JsonObject {
  return { class: "unknown", missing_reason: "x", ...overrides };
}

function envEvidence(overrides: JsonObject = {}): JsonObject {
  return {
    source: "dispatch_failure_class",
    ref: "evt-1",
    observed_at: "2026-11-01T10:00:00Z",
    first_model_turn_at: null,
    ...overrides,
  };
}

function envFail(evidence: unknown): JsonObject {
  return { class: "environment_failure", kind: "environment", env_evidence: evidence };
}

function commits(attribution: string, basis: string, flag: boolean | null): JsonObject {
  return {
    final_commit_attribution: attribution,
    attribution_basis: basis,
    autocommit_flag: flag,
  };
}

function hiddenReceiptBody(): ReceiptClaimBody {
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

function signReceipt(claim: ReceiptClaimBody): ReceiptClaimBody {
  const unsigned: ReceiptClaimBody = { ...claim, receipt_digest: null };
  return { ...unsigned, receipt_digest: receiptDigest(unsigned) };
}

function signJsonObject(claim: JsonObject): JsonObject {
  return { ...claim, receipt_digest: digestOf(claim, { omit: ["receipt_digest"] }) };
}

test("case 1: ModelIdentity effective accepts unknown provenance, rejects invalid shapes", () => {
  parses(
    ModelIdentitySchema,
    modelIdentity({
      effective: {
        value: null,
        provenance: "unknown",
        missing_reason: "no_acp_model_event",
      },
    }),
  );
  rejects(ModelIdentitySchema, modelIdentity({ effective: { value: null } }));
  rejects(
    ModelIdentitySchema,
    modelIdentity({ effective: { value: "qwen3", provenance: "unattested" } }),
  );
  rejects(
    ModelIdentitySchema,
    modelIdentity({ effective: { value: "x", provenance: "declared" } }),
  );
});

test("case 2: ModelIdentity is strict and provenance is a closed enum", () => {
  rejects(ModelIdentitySchema, modelIdentity({ weights_sha256: HEX64_C }));
  rejects(
    ModelIdentitySchema,
    modelIdentity({ requested: { value: "m", provenance: "hashed_at_dispatch" } }),
  );
});

test("case 3: GitShaSchema accepts 40/64 lowercase hex matching FULL_GIT_SHA_RE", () => {
  rejects(GitShaSchema, "abc1234");
  rejects(GitShaSchema, "A".repeat(40));
  parses(GitShaSchema, "a".repeat(40));
  parses(GitShaSchema, "b".repeat(64));
  for (const s of ["a".repeat(40), "b".repeat(64), "abc1234", "A".repeat(40), "g".repeat(41)]) {
    expect(GitShaSchema.safeParse(s).success).toBe(FULL_GIT_SHA_RE.test(s));
  }
});

test("case 4: ReceiptClaim rejects extra keys and lane_gate sha", () => {
  const laneGate: JsonObject = {
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
  parses(ReceiptClaimSchema, laneGate);
  for (const key of ["independent", "verified", "verification"]) {
    rejects(ReceiptClaimSchema, { ...laneGate, [key]: true });
  }
  rejects(ReceiptClaimSchema, { ...laneGate, sha: SHA40 });
  expect(LaneCloseMetadataSchema.safeParse({ head_sha: SHA40 }).success).toBe(false);
});

test("case 5: receiptDigest signs claims, ignores key order, rejects tampering", () => {
  const signed = signReceipt(hiddenReceiptBody());
  parses(ReceiptClaimSchema, signed);
  expect(signed.receipt_digest).toBe(receiptDigest(signed));
  const reordered: ReceiptClaimBody = {
    producer: "grader",
    kind: "hidden_assertion",
    control_verdict: "pass",
    per_check: [
      { ok: true, id: "c1" },
      { ok: false, id: "c2" },
    ],
    fail_reason: "hidden_failed",
    assertion_set_digest: HEX64_1,
    grader_build: HEX64_2,
    sha: SHA40,
    claimed_verdict: "fail",
    receipt_digest: null,
  };
  expect(receiptDigest(reordered)).toBe(receiptDigest(hiddenReceiptBody()));
  rejects(ReceiptClaimSchema, { ...signed, producer: "someone-else" });
  rejects(ReceiptClaimSchema, { ...signed, receipt_digest: HEX64_C });
});

test("case 6: hidden_assertion receipt semantic guards", () => {
  const signed = signReceipt(hiddenReceiptBody());
  rejects(ReceiptClaimSchema, { ...signed, claimed_verdict: "pass" });
  rejects(ReceiptClaimSchema, signReceipt({ ...hiddenReceiptBody(), grader_build: null }));
  rejects(ReceiptClaimSchema, signReceipt({ ...hiddenReceiptBody(), producer: "worker" }));
  rejects(ReceiptClaimSchema, signReceipt({ ...hiddenReceiptBody(), control_verdict: "fail" }));
  rejects(
    ReceiptClaimSchema,
    signReceipt({
      ...hiddenReceiptBody(),
      claimed_verdict: "pass",
      per_check: [
        { id: "c1", ok: true },
        { id: "c2", ok: true },
      ],
    }),
  );
  rejects(
    ReceiptClaimSchema,
    signReceipt({
      ...hiddenReceiptBody(),
      claimed_verdict: "pass",
      fail_reason: null,
    }),
  );
  rejects(
    ReceiptClaimSchema,
    signReceipt({
      ...hiddenReceiptBody(),
      per_check: [
        { id: "c1", ok: true },
        { id: "c1", ok: false },
      ],
    }),
  );
});

test("case 7: observed_outcome class and expectation_ref rules", () => {
  for (const cls of ["solved_verified", "solved_unverified", "blocked_incorrect"]) {
    rejects(ObservedOutcomeSchema, out({ class: cls }));
    rejects(ObservedOutcomeSchema, { class: cls });
  }
  parses(ObservedOutcomeSchema, { class: "model_failure", reason: "incorrect_blocked" });
  rejects(ObservedOutcomeSchema, {
    class: "model_failure",
    reason: "incorrect_blocked",
    missing_reason: null,
  });
  rejects(ObservedOutcomeSchema, { class: "blocked_correct" });
});

test("case 8: environment_failure requires env_evidence and closed kind", () => {
  const evidence = envEvidence();
  rejects(ObservedOutcomeSchema, envFail(null));
  rejects(ObservedOutcomeSchema, omit(envFail(evidence), "env_evidence"));
  rejects(ObservedOutcomeSchema, omit(envFail(evidence), "kind"));
  rejects(ObservedOutcomeSchema, { ...envFail(evidence), kind: "sideloaded" });
  rejects(ObservedOutcomeSchema, { ...envFail(evidence), reason: "worktree_setup_failed" });
  parses(ObservedOutcomeSchema, envFail(evidence));
  rejects(
    ObservedOutcomeSchema,
    envFail(envEvidence({ source: "worktree_setup_failed", observed_at: null })),
  );
  rejects(
    ObservedOutcomeSchema,
    envFail(
      envEvidence({
        source: "worktree_setup_failed",
        observed_at: "2026-11-01T10:00:05Z",
        first_model_turn_at: "2026-11-01T10:00:01Z",
      }),
    ),
  );
  parses(
    ObservedOutcomeSchema,
    envFail(
      envEvidence({
        source: "worktree_setup_failed",
        observed_at: "2026-11-01T10:00:01Z",
        first_model_turn_at: "2026-11-01T10:00:05Z",
      }),
    ),
  );
  parses(
    ObservedOutcomeSchema,
    envFail(
      envEvidence({
        source: "worktree_setup_failed",
        observed_at: "2026-11-01T10:00:01Z",
        first_model_turn_at: null,
      }),
    ),
  );
  for (const reason of ["candidate_timeout", "base_not_ancestor", "contract_violation"]) {
    parses(ObservedOutcomeSchema, { class: "model_failure", reason });
  }
  rejects(ObservedOutcomeSchema, out({ class: "unknown", missing_reason: null }));
});

test("case 9: dispatch_failure_class env source is invalid for controlled episodes", () => {
  const envFailFrom = (source: string): JsonObject => envFail(envEvidence({ source }));
  rejects(EpisodeSchema, epControlled({ observed_outcome: envFailFrom("dispatch_failure_class") }));
  parses(EpisodeSchema, ep({ observed_outcome: envFailFrom("dispatch_failure_class") }));
  parses(EpisodeSchema, epControlled({ observed_outcome: envFailFrom("grader_control_failed") }));
});

test("case 10: commit attribution and autocommit_flag rules", () => {
  const obsWithAttempt = (commitsField: JsonObject): JsonObject =>
    ep({
      attempt_history: history("complete", null, 1, "claim_events"),
      attempts: [att(1, SHA40, { commits: commitsField })],
      final_sha: SHA40,
    });
  rejects(EpisodeSchema, obsWithAttempt(commits("unknown", "none", false)));
  rejects(EpisodeSchema, obsWithAttempt(commits("recovery", "none", null)));
  rejects(EpisodeSchema, obsWithAttempt(commits("model", "none", null)));
  parses(
    EpisodeSchema,
    epControlled({
      harness_build: { sha: HEX64_C },
      attempts: [att(1, SHA40, { commits: commits("model", "controlled_harness_build", null) })],
    }),
  );
  rejects(
    EpisodeSchema,
    epControlled({
      harness_build: { sha: HEX64_C, missing_reason: null },
      attempts: [att(1, SHA40, { commits: commits("model", "controlled_harness_build", null) })],
    }),
  );
});

test("case 11: scope fields pin contract_flags/handoff_reliability/usage", () => {
  rejects(
    EpisodeSchema,
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
    EpisodeSchema,
    ep({
      handoff_reliability: {
        scope: "attempt",
        status: "complete",
        recommended_action: "accept",
      },
    }),
  );
  rejects(
    EpisodeSchema,
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

test("case 12: attempt_history status/count rules vs attempts", () => {
  rejects(
    EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 1, "claim_events"),
      attempts: [att(0, SHA40)],
      final_sha: SHA40,
    }),
  );
  rejects(
    EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 3, "claim_events"),
      attempts: [att(1, SHA40), att(3, SHA40)],
      final_sha: SHA40,
    }),
  );
  rejects(
    EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 1, "claim_events"),
      attempts: [att(2, SHA40)],
      final_sha: SHA40,
    }),
  );
  parses(
    EpisodeSchema,
    ep({
      attempt_history: history("partial", "claims_pruned", 2, "handoff_counter"),
      attempts: [att(2, SHA40)],
      final_sha: SHA40,
    }),
  );
  rejects(
    EpisodeSchema,
    ep({
      attempt_history: history("partial", "claims_pruned", 1, "handoff_counter"),
      attempts: [att(1, SHA40)],
      final_sha: SHA40,
    }),
  );
  rejects(
    EpisodeSchema,
    ep({
      attempt_history: history("partial", "claims_pruned", 3, "handoff_counter"),
      attempts: [att(2, SHA40)],
      final_sha: SHA40,
    }),
  );
  rejects(
    EpisodeSchema,
    ep({ attempt_history: history("unavailable", "events_absent", null, "claim_events") }),
  );
  parses(
    EpisodeSchema,
    ep({
      attempt_history: history("unavailable", "retention_window", 2, "handoff_counter_lower_bound"),
    }),
  );
  rejects(
    EpisodeSchema,
    ep({
      attempt_history: history("unavailable", "retention_window", 2, "handoff_counter_lower_bound"),
      attempts: [att(1, SHA40)],
      final_sha: SHA40,
    }),
  );
});

test("case 13: lineage_usage completeness and attempt usage missing_reason", () => {
  rejects(LineageUsageSchema, {
    tokens: null,
    cost_usd: null,
    handoff_ids_counted: 0,
    complete: true,
    incomplete_reason: null,
  });
  rejects(LineageUsageSchema, {
    tokens: 120,
    cost_usd: null,
    handoff_ids_counted: 3,
    complete: false,
    incomplete_reason: null,
  });
  parses(LineageUsageSchema, {
    tokens: 120,
    cost_usd: null,
    handoff_ids_counted: 3,
    complete: false,
    incomplete_reason: "t0_retention_window",
  });
  rejects(UsageSchema, {
    tokens: null,
    cost_usd: null,
    scope: "attempt",
    missing_reason: null,
  });
  rejects(UsageSchema, {
    tokens: 0,
    cost_usd: null,
    scope: "attempt",
    missing_reason: null,
  });
  parses(UsageSchema, { tokens: 0, cost_usd: null, scope: "attempt" });
});

test("case 14: episode strictness, recipe/fixture coupling, task_digest hex", () => {
  rejects(EpisodeSchema, ep({ recipe_id: "r1" }));
  rejects(EpisodeSchema, ep({ hidden_assertions: [] }));
  rejects(EpisodeSchema, ep({ hidden_assertions_ref: "x" }));
  rejects(EpisodeSchema, epControlled({ family_id: "fam-syn-b" }));
  rejects(EpisodeSchema, epControlled({ fixture_ref: null }));
  rejects(EpisodeSchema, ep({ task_digest: "xyz" }));
});

test("case 15: labels reject agent_performance reserved metadata keys", () => {
  for (const key of AGENT_PERFORMANCE_RESERVED_METADATA_KEYS) {
    rejects(EpisodeSchema, ep({ labels: { [key]: "x" } }));
  }
});

test("case 16: RecipeSchema arm options and pending_upstream without blocked_on", () => {
  const recipe: JsonObject = {
    recipe_id: "r1",
    arm: "minimal",
    components: {
      source: { status: "materialized", sha256: HEX64_1 },
      docs: { status: "pending_upstream", blocked_on: "#392" },
    },
    limits: { max_rounds: 2 },
    seed: { value: null, supported: false },
  };
  parses(RecipeSchema, recipe);
  parses(RecipeSchema, {
    recipe_id: "r-plan",
    arm: "minimal",
    components: {},
    limits: { timeout_s: 5 },
    seed: { value: null, supported: false },
  });
  rejects(RecipeSchema, { ...recipe, created_at: null });
  expect([...RecipeArmSchema.options].sort()).toEqual([
    "bounded_repair",
    "capsule",
    "minimal",
    "verified_memory",
  ]);
  for (const arm of ["bounded_repair", "capsule", "verified_memory"]) {
    parses(RecipeSchema, { ...recipe, arm });
  }
  rejects(RecipeSchema, { ...recipe, arm: "unbounded" });
  rejects(RecipeSchema, omit(recipe, "arm"));
  rejects(RecipeSchema, { ...recipe, components: { docs: { status: "pending_upstream" } } });
  rejects(RecipeSchema, { ...recipe, components: { src: { status: "materialized" } } });
  rejects(RecipeSchema, {
    ...recipe,
    components: { src: { status: "materialized", sha256: "xyz" } },
  });
  rejects(RecipeSchema, omit(recipe, "components"));
  rejects(RecipeSchema, omit(recipe, "limits"));
  rejects(RecipeSchema, { ...recipe, limits: { max_rounds: 0 } });
  rejects(RecipeSchema, { ...recipe, limits: { max_rounds: 1.5 } });
  rejects(RecipeSchema, omit(recipe, "seed"));
  rejects(RecipeSchema, { ...recipe, seed: { value: 1.5, supported: true } });
  rejects(RecipeSchema, { ...recipe, seed: { value: null } });
  rejects(RecipeSchema, { ...recipe, arms: ["minimal"] });
  rejects(RecipeSchema, { ...recipe, status: "ready" });
  rejects(RecipeSchema, { ...recipe, blocked_on: "#392" });
  parses(RecipeSchema, { ...recipe, notes: "hand-tuned" });
  parses(RecipeSchema, { ...recipe, seed: { value: 7, supported: true } });
});

test("case 28: fail_reason nondeterministic is a first-class receipt outcome", () => {
  parses(
    ReceiptClaimSchema,
    signReceipt({ ...hiddenReceiptBody(), fail_reason: "nondeterministic" }),
  );
  parses(ObservedOutcomeSchema, { class: "model_failure", reason: "nondeterministic" });
  rejects(
    ReceiptClaimSchema,
    signJsonObject({ ...hiddenReceiptBody(), fail_reason: "sideloaded_failure" }),
  );
  rejects(
    ReceiptClaimSchema,
    signReceipt({
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

test("case 29: final_sha must be explained by last attempt head or human_takeover", () => {
  const hist = history("complete", null, 1, "claim_events");
  rejects(
    EpisodeSchema,
    ep({ final_sha: SHA40, attempts: [att(1, SHA40_B)], attempt_history: hist }),
  );
  parses(EpisodeSchema, ep({ final_sha: SHA40, attempts: [att(1, SHA40)], attempt_history: hist }));
  rejects(EpisodeSchema, ep({ final_sha: SHA40 }));
  parses(
    EpisodeSchema,
    ep({
      final_sha: SHA40,
      attempts: [att(1, SHA40_B)],
      attempt_history: hist,
      assistance: [{ kind: "human_takeover", attempt_n: 1, ref: SHA40 }],
    }),
  );
  rejects(
    EpisodeSchema,
    ep({
      final_sha: SHA40,
      attempts: [att(1, SHA40_B)],
      attempt_history: hist,
      assistance: [{ kind: "operator_note", attempt_n: 1, ref: SHA40 }],
    }),
  );
  rejects(
    EpisodeSchema,
    ep({
      final_sha: SHA40,
      attempts: [att(1, SHA40), att(2, null)],
      attempt_history: history("complete", null, 2, "claim_events"),
    }),
  );
  parses(
    EpisodeSchema,
    ep({ final_sha: null, attempts: [att(1, SHA40_B)], attempt_history: hist }),
  );
});

test("case 30: blocked_correct requires expectation_ref and a fixture_ref", () => {
  const blocked: JsonObject = { class: "blocked_correct", expectation_ref: "exp-1" };
  rejects(EpisodeSchema, ep({ observed_outcome: blocked }));
  parses(EpisodeSchema, epControlled({ observed_outcome: blocked }));
});

test("case 33: task_refs issues sorted/unique/positive, bundle_ids lowercase", () => {
  parses(EpisodeSchema, ep({ task_refs: { issues: [390], bundle_ids: ["op-x1"] } }));
  rejects(EpisodeSchema, ep({ task_refs: { issues: [400, 390], bundle_ids: [] } }));
  rejects(EpisodeSchema, ep({ task_refs: { issues: [390, 390], bundle_ids: [] } }));
  rejects(EpisodeSchema, ep({ task_refs: { issues: [0], bundle_ids: [] } }));
  rejects(EpisodeSchema, ep({ task_refs: undefined }));
  rejects(EpisodeSchema, ep({ task_refs: { issues: [], bundle_ids: ["OP"] } }));
});

test("case 34: controlled fixture replay shape", () => {
  parses(EpisodeSchema, epControlled());
  rejects(
    EpisodeSchema,
    ep({
      lineage: { root_handoff_id: null, handoff_ids: [], shape: "fixture" },
      attempt_history: history("complete", null, 1, "fixture_replay"),
      attempts: [att(1, SHA40)],
      final_sha: SHA40,
    }),
  );
  rejects(
    EpisodeSchema,
    epControlled({ lineage: { root_handoff_id: null, handoff_ids: [], shape: "single" } }),
  );
  rejects(
    EpisodeSchema,
    epControlled({ attempt_history: history("complete", null, 1, "claim_events") }),
  );
});

test("case 37: receipt digest covers every claim field", () => {
  expect(signJsonObject(hiddenReceiptBody()).receipt_digest).toBe(
    signReceipt(hiddenReceiptBody()).receipt_digest,
  );
  for (const extra of [
    { independent: true },
    { control: { verdict: "pass" } },
    { per_check: [{ id: "c1", ok: true, expect: {} }] },
    { per_check: [{ id: "attempt_reset", ok: true }] },
  ]) {
    const claim: JsonObject = { ...hiddenReceiptBody(), ...extra };
    rejects(ReceiptClaimSchema, signJsonObject(claim));
  }
  parses(ReceiptClaimSchema, signReceipt(hiddenReceiptBody()));
});

test("case 38: ReceiptClaim requires explicit nulls, not absent keys", () => {
  const laneGate: JsonObject = {
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
  parses(ReceiptClaimSchema, laneGate);
  for (const key of [
    "sha",
    "assertion_set_digest",
    "grader_build",
    "per_check",
    "control_verdict",
    "receipt_digest",
  ]) {
    rejects(ReceiptClaimSchema, omit(laneGate, key));
  }
});

test("case 39: identity carries requested (not declared/provider) with provenance", () => {
  parses(ModelIdentitySchema, modelIdentity());
  rejects(ModelIdentitySchema, {
    ...modelIdentity(),
    provider: { value: null, provenance: "unknown", missing_reason: "x" },
  });
  rejects(ModelIdentitySchema, {
    ...modelIdentity(),
    declared: { value: null, provenance: "unknown", missing_reason: "x" },
  });
  parses(
    ModelIdentitySchema,
    modelIdentity({ requested: { value: "gpt-x", provenance: "declared" } }),
  );
  rejects(
    ModelIdentitySchema,
    modelIdentity({
      requested: { value: null, provenance: "acp_selected", missing_reason: "x" },
    }),
  );
});

test("case 40: identity null/value and provenance stay coupled", () => {
  rejects(
    ModelIdentitySchema,
    modelIdentity({
      effective: { value: "qwen3", provenance: "unattested", missing_reason: "x" },
    }),
  );
  rejects(
    ModelIdentitySchema,
    modelIdentity({ effective: { value: null, provenance: "unattested" } }),
  );
  parses(
    ModelIdentitySchema,
    modelIdentity({
      effective: { value: null, provenance: "unattested", missing_reason: "no_acp_event" },
    }),
  );
  rejects(
    ModelIdentitySchema,
    modelIdentity({
      effective: { value: null, provenance: "acp_selected", missing_reason: "x" },
    }),
  );
});

test("case 41: EnvEvidenceSchema requires ref and observed_at for worktree setup", () => {
  parses(EnvEvidenceSchema, envEvidence());
  parses(EnvEvidenceSchema, {
    source: "dispatch_failure_class",
    ref: "evt-2",
    observed_at: null,
    first_model_turn_at: null,
  });
  rejects(EnvEvidenceSchema, omit(envEvidence(), "ref"));
  rejects(EnvEvidenceSchema, envEvidence({ ref: null }));
  rejects(EnvEvidenceSchema, envEvidence({ ref: "" }));
  rejects(EnvEvidenceSchema, omit(envEvidence(), "observed_at"));
  rejects(EnvEvidenceSchema, omit(envEvidence(), "first_model_turn_at"));
  rejects(EnvEvidenceSchema, { source: "worktree_setup_failed", ref: "evt-1" });
  rejects(EnvEvidenceSchema, {
    source: "worktree_setup_failed",
    ref: "evt-1",
    observed_at: null,
    first_model_turn_at: null,
  });
  rejects(EnvEvidenceSchema, envEvidence({ source: "sideloaded" }));
});

test("case 42: worktree ordering compares instants across offsets and fractions", () => {
  parses(EnvEvidenceSchema, {
    source: "worktree_setup_failed",
    ref: "evt-1",
    observed_at: "2026-11-01T10:00:05+02:00",
    first_model_turn_at: "2026-11-01T09:00:00Z",
  });
  rejects(EnvEvidenceSchema, {
    source: "worktree_setup_failed",
    ref: "evt-1",
    observed_at: "2026-11-01T10:00:05+02:00",
    first_model_turn_at: "2026-11-01T07:30:00Z",
  });
  parses(EnvEvidenceSchema, {
    source: "worktree_setup_failed",
    ref: "evt-1",
    observed_at: "2026-11-01T10:00:05.400Z",
    first_model_turn_at: "2026-11-01T10:00:05.500Z",
  });
  rejects(EnvEvidenceSchema, {
    source: "worktree_setup_failed",
    ref: "evt-1",
    observed_at: "2026-11-01T10:00:05.500Z",
    first_model_turn_at: "2026-11-01T10:00:05.400Z",
  });
});

test("case 43: IsoTsSchema accepts Z, offset and fractional seconds", () => {
  parses(IsoTsSchema, "2026-11-01T10:00:00Z");
  parses(IsoTsSchema, "2026-11-01T10:00:00+02:00");
  parses(IsoTsSchema, "2026-11-01T10:00:00.123Z");
  rejects(IsoTsSchema, "2026-11-01");
  rejects(IsoTsSchema, "2026-11-01 10:00:00Z");
});

test("case 44: Attempt requires a handoff_id string and a required timings object", () => {
  parses(AttemptSchema, att(1, SHA40));
  rejects(AttemptSchema, omit(att(1, SHA40), "handoff_id"));
  parses(AttemptSchema, att(1, SHA40, { handoff_id: "" }));
  rejects(AttemptSchema, att(1, SHA40, { handoff_id: 7 }));
  rejects(AttemptSchema, omit(att(1, SHA40), "timings"));
  rejects(AttemptSchema, att(1, SHA40, { timings: omit(attTimings(), "e2e_ms") }));
});

test("case 45: Assistance requires a positive attempt_n and rejects null", () => {
  parses(AssistanceSchema, { kind: "teacher", attempt_n: 1, ref: null });
  parses(AssistanceSchema, { kind: "human_takeover", attempt_n: 2, ref: SHA40 });
  rejects(AssistanceSchema, { kind: "teacher", ref: null });
  rejects(AssistanceSchema, { kind: "teacher", attempt_n: null, ref: null });
  rejects(AssistanceSchema, { kind: "teacher", attempt_n: 0, ref: null });
  rejects(AssistanceSchema, { kind: "coaching", attempt_n: 1, ref: null });
});

test("case 46: partial attempt_history is pinned to the handoff_counter basis", () => {
  parses(AttemptHistorySchema, history("partial", "claims_pruned", 2, "handoff_counter"));
  for (const basis of ["claim_events", "handoff_counter_lower_bound", "fixture_replay"]) {
    rejects(AttemptHistorySchema, history("partial", "claims_pruned", 2, basis));
  }
  rejects(AttemptHistorySchema, history("partial", "retention_window", 2, "handoff_counter"));
  rejects(
    EpisodeSchema,
    ep({
      attempt_history: history("partial", "claims_pruned", 2, "claim_events"),
      attempts: [att(2, SHA40)],
      final_sha: SHA40,
    }),
  );
});

test("case 47: ObservedOutcome variants are exactly the plan shape", () => {
  parses(ObservedOutcomeSchema, { class: "model_failure", reason: "hidden_failed" });
  parses(ObservedOutcomeSchema, {
    class: "environment_failure",
    kind: "environment",
    env_evidence: envEvidence(),
  });
  parses(ObservedOutcomeSchema, { class: "blocked_correct", expectation_ref: "exp-1" });
  parses(ObservedOutcomeSchema, { class: "terminal_unverified" });
  parses(ObservedOutcomeSchema, { class: "unknown", missing_reason: "no_terminal_signal" });
  rejects(ObservedOutcomeSchema, { class: "terminal_unverified", reason: "x" });
  rejects(ObservedOutcomeSchema, {
    class: "environment_failure",
    kind: null,
    env_evidence: envEvidence(),
  });
  rejects(ObservedOutcomeSchema, { class: "environment_failure", env_evidence: envEvidence() });
  rejects(ObservedOutcomeSchema, { class: "environment_failure", kind: "environment" });
  rejects(ObservedOutcomeSchema, { class: "unknown" });
  rejects(ObservedOutcomeSchema, { class: "blocked_correct", expectation_ref: "" });
  rejects(ObservedOutcomeSchema, { class: "model_failure" });
});

test("case 48: Attempt carries no timing timestamps and a required timings object", () => {
  parses(AttemptSchema, att(1, SHA40));
  rejects(AttemptSchema, att(1, SHA40, { handoff_id: null }));
  rejects(AttemptSchema, att(1, SHA40, { started_at: null }));
  rejects(AttemptSchema, att(1, SHA40, { first_model_turn_at: null }));
  rejects(AttemptSchema, att(1, SHA40, { ended_at: null }));
  rejects(AttemptSchema, att(1, SHA40, { timings: null }));
  rejects(AttemptSchema, att(1, SHA40, { timings: { ...attTimings(), extra_ms: 1 } }));
});

test("case 49: ModelIdentity quant/engine/adapter are required", () => {
  parses(ModelIdentitySchema, modelIdentity());
  for (const key of ["quant", "engine", "adapter"]) {
    rejects(ModelIdentitySchema, omit(modelIdentity(), key));
  }
});

test("case 51: null usage tokens require a missing_reason even when the key is absent", () => {
  rejects(UsageSchema, { tokens: null, cost_usd: null, scope: "attempt" });
  parses(UsageSchema, {
    tokens: null,
    cost_usd: null,
    scope: "attempt",
    missing_reason: "usage_events_missing",
  });
});

test("case 52: model commit attribution needs a controlled episode with a harness sha", () => {
  const modelCommits = commits("model", "controlled_harness_build", null);
  rejects(
    EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 1, "claim_events"),
      attempts: [att(1, SHA40, { commits: modelCommits })],
      final_sha: SHA40,
    }),
  );
  rejects(
    EpisodeSchema,
    epControlled({
      harness_build: { sha: null, missing_reason: "x" },
      attempts: [att(1, SHA40, { commits: modelCommits })],
    }),
  );
});

test("case 53: recovery attribution requires autocommit_flag true, not just the basis", () => {
  const withCommits = (commitsField: JsonObject): JsonObject =>
    ep({
      attempt_history: history("complete", null, 1, "claim_events"),
      attempts: [att(1, SHA40, { commits: commitsField })],
      final_sha: SHA40,
    });
  rejects(EpisodeSchema, withCommits(commits("recovery", "dispatch_end_autocommitted", null)));
  parses(EpisodeSchema, withCommits(commits("recovery", "dispatch_end_autocommitted", true)));
});

test("case 54: identityField rejects a null missing_reason", () => {
  rejects(
    ModelIdentitySchema,
    modelIdentity({ effective: { value: null, provenance: "unknown", missing_reason: null } }),
  );
  rejects(
    ModelIdentitySchema,
    modelIdentity({ requested: { value: null, provenance: "unknown", missing_reason: null } }),
  );
});

test("case 55: FixtureRefSchema.family_id accepts the empty string", () => {
  parses(FixtureRefSchema, { family_id: "", variant_id: "v" });
  parses(FixtureRefSchema, { family_id: "fam-390", variant_id: "v1" });
  rejects(FixtureRefSchema, { family_id: "fam-390", variant_id: "V1" });
});

test("case P33c: observational episode with a harness_build sha still rejects model attribution", () => {
  rejects(
    EpisodeSchema,
    ep({
      harness_build: { sha: SHA40 },
      attempt_history: history("complete", null, 1, "claim_events"),
      attempts: [att(1, SHA40, { commits: commits("model", "controlled_harness_build", null) })],
      final_sha: SHA40,
    }),
  );
});

test("case P34b1: recovery attribution rejects the none basis even with the autocommit flag", () => {
  rejects(AttemptSchema, att(1, SHA40, { commits: commits("recovery", "none", true) }));
});

test("case P34b2: recovery attribution rejects controlled_harness_build even with the flag", () => {
  rejects(
    AttemptSchema,
    att(1, SHA40, { commits: commits("recovery", "controlled_harness_build", true) }),
  );
});

test("case P34c: AttemptSchema rejects model attribution without the controlled_harness_build basis", () => {
  rejects(AttemptSchema, att(1, SHA40, { commits: commits("model", "none", null) }));
});

test("case P34d: unknown attribution rejects the dispatch_end_autocommitted basis", () => {
  rejects(
    AttemptSchema,
    att(1, SHA40, { commits: commits("unknown", "dispatch_end_autocommitted", null) }),
  );
});

test("case 60: complete attempt_history count must equal the last attempt n", () => {
  rejects(
    EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 2, "claim_events"),
      attempts: [att(1, SHA40)],
      final_sha: SHA40,
    }),
  );
  parses(
    EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 1, "claim_events"),
      attempts: [att(1, SHA40)],
      final_sha: SHA40,
    }),
  );
  parses(
    EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 2, "claim_events"),
      attempts: [att(1, SHA40), att(2, SHA40)],
      final_sha: SHA40,
    }),
  );
});

test("case 61: complete attempt_history must start at n=1 when the count matches", () => {
  rejects(
    EpisodeSchema,
    ep({
      attempt_history: history("complete", null, 2, "claim_events"),
      attempts: [att(2, SHA40)],
      final_sha: SHA40,
    }),
  );
});

test("case 62: AttemptHistorySchema pins reason and count to the status", () => {
  parses(AttemptHistorySchema, history("complete", null, 1, "claim_events"));
  rejects(AttemptHistorySchema, history("complete", "claims_pruned", 1, "claim_events"));
  parses(AttemptHistorySchema, history("partial", "claims_pruned", 1, "handoff_counter"));
  rejects(AttemptHistorySchema, history("partial", null, 1, "handoff_counter"));
  rejects(AttemptHistorySchema, history("partial", "claims_pruned", null, "handoff_counter"));
  parses(AttemptHistorySchema, history("unavailable", "retention_window", null, "unknown"));
});

test("case 63: worktree setup failure rejects observed_at equal to the first model turn", () => {
  rejects(
    EnvEvidenceSchema,
    envEvidence({
      source: "worktree_setup_failed",
      observed_at: "2026-11-01T10:00:05Z",
      first_model_turn_at: "2026-11-01T10:00:05Z",
    }),
  );
  parses(
    EnvEvidenceSchema,
    envEvidence({
      source: "worktree_setup_failed",
      observed_at: "2026-11-01T10:00:04Z",
      first_model_turn_at: "2026-11-01T10:00:05Z",
    }),
  );
});
