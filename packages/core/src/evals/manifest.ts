import { z } from "zod";

import {
  AGENT_PERFORMANCE_RESERVED_METADATA_KEYS,
  FULL_GIT_SHA_RE,
} from "../schemas/agent-performance.js";
import { digestOf } from "./canonical.js";

export const EVAL_SCHEMA_VERSION = 1;

const RESERVED_LABEL_KEYS: readonly string[] = AGENT_PERFORMANCE_RESERVED_METADATA_KEYS;

export const GitShaSchema = z.string().regex(FULL_GIT_SHA_RE);

export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const IsoTsSchema = z.iso.datetime({ offset: true });

export const AssertionIdSchema = z.string().regex(/^c[0-9]{1,4}$/);

const REL_PATH_RE = /^[A-Za-z0-9._/-]+$/;

export const RelPathSchema = z
  .string()
  .refine((path) => REL_PATH_RE.test(path), { message: "invalid relative path characters" })
  .refine((path) => !path.startsWith("/"), { message: "relative path must not be absolute" })
  .refine((path) => !path.split("/").includes("..") && !path.split("/").includes(".git"), {
    message: "relative path must not traverse .. or .git",
  });

export const FailureTypeSchema = z.enum([
  "missed_commit",
  "lost_evidence",
  "wrong_model_identity",
  "hook_bootstrap_gap",
  "invalid_fixture_contract",
  "long_context_recovery",
  "tool_permission_error",
  "invariant_violated_tests_pass",
]);

type IdentityProvenance =
  | "declared"
  | "unknown"
  | "unattested"
  | "acp_selected"
  | "acp_current"
  | "qualified_artifact";

const NULL_VALUE_PROVENANCES: ReadonlySet<IdentityProvenance> = new Set(["unattested", "unknown"]);

type IdentityFieldOptions = readonly [IdentityProvenance, ...IdentityProvenance[]];

function identityField(
  provenanceOptions: IdentityFieldOptions,
): z.ZodType<{ value: string | null; provenance: IdentityProvenance; missing_reason?: string }> {
  return z
    .strictObject({
      value: z.string().nullable(),
      provenance: z.enum(provenanceOptions),
      missing_reason: z.string().optional(),
    })
    .superRefine((field, ctx) => {
      if (field.value === null && !NULL_VALUE_PROVENANCES.has(field.provenance)) {
        ctx.addIssue({
          code: "custom",
          message: "null value requires unattested or unknown provenance",
        });
      }
      if (NULL_VALUE_PROVENANCES.has(field.provenance)) {
        if (field.value !== null) {
          ctx.addIssue({
            code: "custom",
            message: "unattested or unknown provenance requires a null value",
          });
        }
        if (field.missing_reason === undefined) {
          ctx.addIssue({ code: "custom", message: "missing provenance requires missing_reason" });
        }
      }
    });
}

export const ModelIdentitySchema = z.strictObject({
  requested: identityField(["declared", "unknown"]),
  effective: identityField([
    "acp_selected",
    "acp_current",
    "qualified_artifact",
    "unattested",
    "unknown",
  ]),
  quant: identityField(["declared", "qualified_artifact", "unknown"]),
  engine: identityField(["declared", "qualified_artifact", "unknown"]),
  adapter: identityField(["declared", "qualified_artifact", "unknown"]),
  config_sha256: Sha256HexSchema.nullable(),
  artifact_identity: z.string().nullable(),
});

export const PerCheckSchema = z.strictObject({
  id: AssertionIdSchema,
  ok: z.boolean(),
});

export const ReceiptKindSchema = z.enum([
  "hidden_assertion",
  "lane_gate",
  "reviewer",
  "schema_check",
  "llm_judge",
  "self_report",
]);

const ReceiptClaimInnerSchema = z.strictObject({
  kind: ReceiptKindSchema,
  sha: GitShaSchema.nullable(),
  producer: z.string().min(1),
  claimed_verdict: z.enum(["pass", "fail", "unknown"]),
  fail_reason: z
    .enum([
      "hidden_failed",
      "candidate_timeout",
      "base_not_ancestor",
      "contract_violation",
      "nondeterministic",
    ])
    .nullable(),
  assertion_set_digest: Sha256HexSchema.nullable(),
  grader_build: Sha256HexSchema.nullable(),
  per_check: z.array(PerCheckSchema).nullable(),
  control_verdict: z.enum(["pass", "fail", "timeout"]).nullable(),
  receipt_digest: Sha256HexSchema.nullable(),
});

export type ReceiptClaimBody = z.infer<typeof ReceiptClaimInnerSchema>;

export function receiptDigest(claim: ReceiptClaimBody): string {
  return digestOf(claim, { omit: ["receipt_digest"] });
}

function isReceiptSignedByDigest(claim: ReceiptClaimBody): boolean {
  if (claim.receipt_digest === null) return true;
  return receiptDigest({ ...claim, receipt_digest: null }) === claim.receipt_digest;
}

function checkLaneGate(claim: ReceiptClaimBody, report: (message: string) => void): void {
  if (claim.kind === "lane_gate" && claim.sha !== null) {
    report("lane_gate receipts must carry a null sha");
  }
}

function checkHiddenAssertion(claim: ReceiptClaimBody, report: (message: string) => void): void {
  if (claim.kind !== "hidden_assertion") return;
  if (claim.producer !== "grader") report("hidden_assertion receipts must be produced by grader");
  if (claim.sha === null) report("hidden_assertion requires sha");
  if (claim.assertion_set_digest === null) {
    report("hidden_assertion requires assertion_set_digest");
  }
  if (claim.grader_build === null) {
    report("hidden_assertion requires grader_build");
  }
  if (claim.per_check === null) {
    report("hidden_assertion requires per_check");
  }
  if (claim.control_verdict !== "pass") {
    report("hidden_assertion requires a passing control_verdict");
  }
  if (claim.claimed_verdict === "fail" && claim.fail_reason === null) {
    report("failing hidden_assertion receipts require a fail_reason");
  }
}

function checkPassVerdict(claim: ReceiptClaimBody, report: (message: string) => void): void {
  if (claim.claimed_verdict !== "pass") return;
  if (claim.fail_reason !== null) report("passing receipts must have a null fail_reason");
  if (claim.kind !== "hidden_assertion") return;
  const checks = claim.per_check ?? [];
  if (checks.length === 0 || !checks.every((check) => check.ok)) {
    report("passing hidden_assertion receipts require a non-empty all-ok per_check");
  }
}

function checkUniquePerCheckIds(claim: ReceiptClaimBody, report: (message: string) => void): void {
  const ids = new Set<string>();
  for (const check of claim.per_check ?? []) {
    if (ids.has(check.id)) {
      report(`duplicate per_check id ${check.id}`);
      return;
    }
    ids.add(check.id);
  }
}

export const ReceiptClaimSchema = ReceiptClaimInnerSchema.superRefine((claim, ctx) => {
  const report = (message: string): void => {
    ctx.addIssue({ code: "custom", message });
  };
  checkLaneGate(claim, report);
  checkHiddenAssertion(claim, report);
  checkPassVerdict(claim, report);
  checkUniquePerCheckIds(claim, report);
  if (!isReceiptSignedByDigest(claim)) {
    report("receipt_digest does not match the claim contents");
  }
});

export const ModelFailureReasonSchema = z.enum([
  "no_artifact",
  "visible_tests_failed",
  "hidden_failed",
  "candidate_timeout",
  "base_not_ancestor",
  "contract_violation",
  "self_reported_failure",
  "incorrect_blocked",
  "nondeterministic",
]);

export const EnvEvidenceSourceSchema = z.enum([
  "grader_control_failed",
  "dispatch_failure_class",
  "worktree_setup_failed",
]);

function isAtOrAfter(lhs: string, rhs: string): boolean {
  return Date.parse(lhs) >= Date.parse(rhs);
}

export const EnvEvidenceSchema = z
  .strictObject({
    source: EnvEvidenceSourceSchema,
    ref: z.string().min(1),
    observed_at: IsoTsSchema.nullable(),
    first_model_turn_at: IsoTsSchema.nullable(),
  })
  .superRefine((evidence, ctx) => {
    if (evidence.source !== "worktree_setup_failed") return;
    if (evidence.observed_at === null) {
      ctx.addIssue({
        code: "custom",
        message: "worktree_setup_failed evidence requires observed_at",
      });
      return;
    }
    if (
      evidence.first_model_turn_at !== null &&
      isAtOrAfter(evidence.observed_at, evidence.first_model_turn_at)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "worktree_setup_failed must be observed before the first model turn",
      });
    }
  });

const ModelFailureOutcomeSchema = z.strictObject({
  class: z.literal("model_failure"),
  reason: ModelFailureReasonSchema,
});

const EnvironmentFailureOutcomeSchema = z.strictObject({
  class: z.literal("environment_failure"),
  kind: z.enum(["environment", "baseline", "resource", "auth"]),
  env_evidence: EnvEvidenceSchema,
});

const BlockedCorrectOutcomeSchema = z.strictObject({
  class: z.literal("blocked_correct"),
  expectation_ref: z.string().min(1),
});

const TerminalUnverifiedOutcomeSchema = z.strictObject({
  class: z.literal("terminal_unverified"),
});

const UnknownOutcomeSchema = z.strictObject({
  class: z.literal("unknown"),
  missing_reason: z.string().min(1),
});

export const ObservedOutcomeSchema = z.discriminatedUnion("class", [
  ModelFailureOutcomeSchema,
  EnvironmentFailureOutcomeSchema,
  BlockedCorrectOutcomeSchema,
  TerminalUnverifiedOutcomeSchema,
  UnknownOutcomeSchema,
]);

export type ObservedOutcome = z.infer<typeof ObservedOutcomeSchema>;

const AttemptCommitsSchema = z
  .strictObject({
    final_commit_attribution: z.enum(["model", "recovery", "unknown"]),
    attribution_basis: z.enum(["dispatch_end_autocommitted", "controlled_harness_build", "none"]),
    autocommit_flag: z.literal(true).nullable(),
  })
  .superRefine((commits, ctx) => {
    const report = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    const { final_commit_attribution: attribution, attribution_basis: basis } = commits;
    if (attribution === "recovery") {
      if (commits.autocommit_flag !== true || basis !== "dispatch_end_autocommitted") {
        report("recovery attribution requires the autocommit flag and dispatch_end_autocommitted");
      }
    }
    if (attribution === "model" && basis !== "controlled_harness_build") {
      report("model attribution requires the controlled_harness_build basis");
    }
    if (attribution === "unknown" && basis !== "none") {
      report("unknown attribution requires the none basis");
    }
  });

const ContractFlagsSchema = z.strictObject({
  scope: z.literal("attempt"),
  source: z.enum(["attempt_dispatch_end", "grader", "none"]),
  base_not_ancestor: z.boolean().nullable(),
  identity_mismatch: z.boolean().nullable(),
});

export const UsageSchema = z
  .strictObject({
    tokens: z.number().int().min(0).nullable(),
    cost_usd: z.number().min(0).nullable(),
    scope: z.enum(["attempt", "unknown"]),
    missing_reason: z.string().nullish(),
  })
  .superRefine((usage, ctx) => {
    if (
      usage.tokens === null &&
      (usage.missing_reason === undefined || usage.missing_reason === null)
    ) {
      ctx.addIssue({ code: "custom", message: "null tokens require a missing_reason" });
    }
  });

export const AttemptSchema = z.strictObject({
  n: z.number().int().min(1),
  handoff_id: z.string().min(1),
  dispatch_attempt: z.number().int().min(1).nullable(),
  head_sha: GitShaSchema.nullable(),
  commits: AttemptCommitsSchema,
  contract_flags: ContractFlagsSchema,
  timings: z.strictObject({
    queue_ms: z.number().int().min(0).nullable(),
    exec_ms: z.number().int().min(0).nullable(),
    check_ms: z.number().int().min(0).nullable(),
    e2e_ms: z.number().int().min(0).nullable(),
  }),
  usage: UsageSchema,
});

export type Attempt = z.infer<typeof AttemptSchema>;

export const AssistanceSchema = z.strictObject({
  kind: z.enum([
    "recovery_autocommit",
    "retry_child",
    "chain_hop",
    "fix_round",
    "teacher",
    "human_takeover",
    "operator_note",
  ]),
  attempt_n: z.number().int().min(1).nullable(),
  ref: z.string().nullable(),
});

export const AttemptHistorySchema = z
  .strictObject({
    status: z.enum(["complete", "partial", "unavailable"]),
    reason: z.enum(["retention_window", "events_absent", "claims_pruned"]).nullable(),
    count: z.number().int().min(0).nullable(),
    count_basis: z.enum([
      "claim_events",
      "handoff_counter",
      "handoff_counter_lower_bound",
      "fixture_replay",
      "unknown",
    ]),
  })
  .superRefine((history, ctx) => {
    const report = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (history.status === "complete" && history.reason !== null) {
      report("complete attempt_history must have a null reason");
    }
    if (history.status === "partial") {
      if (history.reason !== "claims_pruned")
        report("partial attempt_history requires claims_pruned");
      if (history.count_basis !== "handoff_counter") {
        report("partial attempt_history requires the handoff_counter basis");
      }
      if (history.count === null) report("partial attempt_history requires a count");
    }
  });

export const LineageUsageSchema = z
  .strictObject({
    tokens: z.number().int().min(0).nullable(),
    cost_usd: z.number().min(0).nullable(),
    handoff_ids_counted: z.number().int().min(1),
    complete: z.boolean(),
    incomplete_reason: z.enum(["t0_retention_window", "handoff_usage_missing"]).nullable(),
  })
  .superRefine((usage, ctx) => {
    const report = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (usage.complete && usage.incomplete_reason !== null) {
      report("complete lineage_usage must have a null incomplete_reason");
    }
    if (!usage.complete && usage.incomplete_reason === null) {
      report("incomplete lineage_usage requires an incomplete_reason");
    }
    if (usage.tokens === null && usage.complete) {
      report("null tokens mean lineage_usage cannot be complete");
    }
  });

export const LineageSchema = z.strictObject({
  root_handoff_id: z.string().nullable(),
  handoff_ids: z.array(z.string()),
  shape: z.enum(["single", "chain", "branching", "fixture"]),
});

export const FixtureRefSchema = z.strictObject({
  family_id: z.string().min(1),
  variant_id: z.string().regex(/^[a-z0-9-]+$/),
});

function ascendingPair(prev: string | number, current: string | number): boolean {
  if (typeof prev === "number" && typeof current === "number") return current > prev;
  if (typeof prev === "string" && typeof current === "string") return current > prev;
  return false;
}

function isStrictlyAscending(values: readonly (string | number)[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const prev = values[index - 1];
    const current = values[index];
    if (prev === undefined || current === undefined) return false;
    if (!ascendingPair(prev, current)) return false;
  }
  return true;
}

export const TaskRefsSchema = z
  .strictObject({
    issues: z.array(z.number().int().min(1)),
    bundle_ids: z.array(z.string().regex(/^[a-z0-9-]{3,48}$/)),
  })
  .superRefine((refs, ctx) => {
    if (!isStrictlyAscending(refs.issues)) {
      ctx.addIssue({ code: "custom", message: "task_refs.issues must be strictly ascending" });
    }
    if (!isStrictlyAscending(refs.bundle_ids)) {
      ctx.addIssue({
        code: "custom",
        message: "task_refs.bundle_ids must be strictly ascending",
      });
    }
  });

export const RecipeArmSchema = z.enum(["minimal", "capsule", "bounded_repair", "verified_memory"]);

export const RecipeComponentSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("materialized"), sha256: Sha256HexSchema }),
  z.strictObject({
    status: z.literal("pending_upstream"),
    blocked_on: z.string().regex(/^#\d+$/),
  }),
]);

export const RecipeSchema = z
  .strictObject({
    recipe_id: z.string().min(1),
    arm: RecipeArmSchema,
    components: z.record(z.string(), RecipeComponentSchema),
    limits: z.record(z.string(), z.number().int().min(1)),
    seed: z.strictObject({ value: z.number().int().nullable(), supported: z.boolean() }),
    notes: z.string().optional(),
    created_at: z.string().nullable(),
  })
  .superRefine((recipe, ctx) => {
    if (!("max_rounds" in recipe.limits)) {
      ctx.addIssue({ code: "custom", message: "recipe limits must include max_rounds" });
    }
  });

const HandoffReliabilitySchema = z.strictObject({
  scope: z.literal("handoff_latest"),
  status: z.string().nullable(),
});

export const EpisodeSchemaInner = z.strictObject({
  schema_version: z.literal(1),
  episode_id: z.string().min(1),
  family_id: z.string().min(1),
  fixture_ref: FixtureRefSchema.nullable(),
  split: z.enum(["train", "dev", "holdout"]),
  design: z.enum(["observational", "controlled"]),
  failure_type: FailureTypeSchema.nullable(),
  task_digest: Sha256HexSchema.nullable(),
  task_refs: TaskRefsSchema,
  repo: z.strictObject({
    base_sha: GitShaSchema.nullable(),
    dependency_lock_sha256: Sha256HexSchema.nullable(),
  }),
  recipe_id: z.string().nullable(),
  model_identity: ModelIdentitySchema,
  harness_build: z.strictObject({
    sha: GitShaSchema.nullable(),
    missing_reason: z.string().nullish(),
  }),
  environment: z.strictObject({
    worktree_kind: z.string().nullable(),
    os: z.string().nullable(),
    bun_version: z.string().nullable(),
  }),
  lineage: LineageSchema,
  attempt_history: AttemptHistorySchema,
  attempts: z.array(AttemptSchema),
  assistance: z.array(AssistanceSchema),
  final_sha: GitShaSchema.nullable(),
  receipts: z.array(ReceiptClaimSchema),
  observed_outcome: ObservedOutcomeSchema,
  handoff_reliability: HandoffReliabilitySchema.nullable(),
  lineage_usage: LineageUsageSchema.nullable(),
  labels: z.record(z.string(), z.string()),
});

export type EpisodeBody = z.infer<typeof EpisodeSchemaInner>;

type EpisodeReport = (message: string) => void;

function ruleObservationalHasNoRecipe(ep: EpisodeBody, report: EpisodeReport): void {
  if (ep.design === "observational" && ep.recipe_id !== null) {
    report("observational episodes must have a null recipe_id");
  }
}

function ruleAttemptNumbersContiguous(ep: EpisodeBody, report: EpisodeReport): void {
  const numbers = ep.attempts.map((attempt) => attempt.n);
  const contiguous = numbers.every(
    (value, index) => index === 0 || value === (numbers[index - 1] ?? value + 1) + 1,
  );
  if (!contiguous) report("attempt n values must be contiguous");
}

function checkCompleteHistory(
  ep: EpisodeBody,
  first: number | undefined,
  last: number | undefined,
  report: EpisodeReport,
): void {
  if (ep.attempts.length === 0) return;
  if (first !== 1) report("complete attempt_history with attempts must start at n=1");
  const { count } = ep.attempt_history;
  if (count !== null && last !== count) report("complete attempt_history count must match last n");
}

function checkPartialHistory(
  ep: EpisodeBody,
  first: number | undefined,
  last: number | undefined,
  report: EpisodeReport,
): void {
  if (ep.attempts.length === 0) report("partial attempt_history requires at least one attempt");
  if (first !== undefined && first <= 1) report("partial attempt_history must start above n=1");
  const { count } = ep.attempt_history;
  if (count !== null && last !== count) report("partial attempt_history count must match last n");
}

function checkUnavailableHistory(ep: EpisodeBody, report: EpisodeReport): void {
  if (ep.attempts.length > 0) report("unavailable attempt_history must have no attempts");
  if (ep.attempt_history.count_basis === "claim_events") {
    report("unavailable attempt_history cannot use the claim_events basis");
  }
}

function ruleAttemptHistoryMatchesAttempts(ep: EpisodeBody, report: EpisodeReport): void {
  const first = ep.attempts[0]?.n;
  const last = ep.attempts[ep.attempts.length - 1]?.n;
  const { status } = ep.attempt_history;
  if (status === "complete") checkCompleteHistory(ep, first, last, report);
  if (status === "partial") checkPartialHistory(ep, first, last, report);
  if (status === "unavailable") checkUnavailableHistory(ep, report);
}

function ruleModelAttributionNeedsHarness(ep: EpisodeBody, report: EpisodeReport): void {
  const hasModelAttribution = ep.attempts.some(
    (attempt) => attempt.commits.final_commit_attribution === "model",
  );
  if (!hasModelAttribution) return;
  if (ep.design !== "controlled" || ep.harness_build.sha === null) {
    report("model commit attribution requires a controlled episode with a harness_build sha");
  }
}

function ruleFixtureCoupling(ep: EpisodeBody, report: EpisodeReport): void {
  if (ep.fixture_ref !== null && ep.fixture_ref.family_id !== ep.family_id) {
    report("fixture_ref.family_id must equal the episode family_id");
  }
  if (ep.design === "controlled" && ep.fixture_ref === null) {
    report("controlled episodes require a fixture_ref");
  }
}

function ruleControlledEnvironmentSource(ep: EpisodeBody, report: EpisodeReport): void {
  if (ep.design !== "controlled" || ep.observed_outcome.class !== "environment_failure") return;
  const source = ep.observed_outcome.env_evidence.source;
  if (source !== "grader_control_failed" && source !== "worktree_setup_failed") {
    report("controlled environment_failure evidence must come from grader or worktree setup");
  }
}

function ruleLabelsAvoidReservedKeys(ep: EpisodeBody, report: EpisodeReport): void {
  for (const key of Object.keys(ep.labels)) {
    if (RESERVED_LABEL_KEYS.includes(key)) {
      report(`labels must not use reserved metadata key ${key}`);
      return;
    }
  }
}

function ruleFinalShaExplained(ep: EpisodeBody, report: EpisodeReport): void {
  if (ep.final_sha === null) return;
  const lastHead = ep.attempts[ep.attempts.length - 1]?.head_sha;
  if (lastHead === ep.final_sha) return;
  const takeover = ep.assistance.some(
    (entry) => entry.kind === "human_takeover" && entry.ref === ep.final_sha,
  );
  if (!takeover) report("final_sha must match the last attempt head_sha or a human_takeover ref");
}

function ruleBlockedCorrectNeedsFixture(ep: EpisodeBody, report: EpisodeReport): void {
  if (ep.observed_outcome.class === "blocked_correct" && ep.fixture_ref === null) {
    report("blocked_correct outcomes require a fixture_ref");
  }
}

function ruleFixtureReplayCoupling(ep: EpisodeBody, report: EpisodeReport): void {
  const isFixtureBasis = ep.attempt_history.count_basis === "fixture_replay";
  const isFixtureShape = ep.lineage.shape === "fixture";
  if (isFixtureBasis !== isFixtureShape) {
    report("count_basis fixture_replay requires lineage.shape fixture and vice versa");
  }
  if ((isFixtureBasis || isFixtureShape) && ep.design !== "controlled") {
    report("fixture replay lineage requires a controlled episode");
  }
}

const EPISODE_RULES: ((ep: EpisodeBody, report: EpisodeReport) => void)[] = [
  ruleObservationalHasNoRecipe,
  ruleAttemptNumbersContiguous,
  ruleAttemptHistoryMatchesAttempts,
  ruleModelAttributionNeedsHarness,
  ruleFixtureCoupling,
  ruleControlledEnvironmentSource,
  ruleLabelsAvoidReservedKeys,
  ruleFinalShaExplained,
  ruleBlockedCorrectNeedsFixture,
  ruleFixtureReplayCoupling,
];

export const EpisodeSchema = EpisodeSchemaInner.superRefine((episode, ctx) => {
  const report: EpisodeReport = (message) => {
    ctx.addIssue({ code: "custom", message });
  };
  for (const rule of EPISODE_RULES) {
    rule(episode, report);
  }
});

export type Episode = z.infer<typeof EpisodeSchema>;
