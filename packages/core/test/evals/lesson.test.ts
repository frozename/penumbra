import { beforeAll, expect, test } from "bun:test";

import { EpisodeSchema, type ReceiptClaimBody, receiptDigest } from "@src/evals/manifest.js";

type JsonObject = Record<string, unknown>;

// Input and output shapes are declared locally: lesson.ts does not exist at
// the base, so no value or type may be imported from it.
type LessonDraft = {
  project_id: string;
  polarity: "positive" | "negative";
  failure_signature: string;
  root_cause: string;
  procedure: string[];
  applicability: string[];
  exclusions: string[];
  counterexample: string | null;
  created_at: string;
  expires_at: string;
};
type LessonContribution = { kind: string; attempt_n: number };
type LessonSource = {
  episode_id: string;
  family_id: string;
  final_sha: string | null;
  receipt_digests: string[];
};
type LessonScope = {
  project_id: string;
  harness_build_sha: string | null;
  engine: string | null;
  dependency_lock_sha256: string | null;
};
type Lesson = {
  lesson_id: string;
  review: string;
  approved_by: string | null;
  authority: string;
  polarity: string;
  source: LessonSource;
  scope: LessonScope;
  contributions: LessonContribution[];
  failure_signature: string;
  root_cause: string;
  procedure: string[];
  applicability: string[];
  exclusions: string[];
  counterexample: string | null;
  created_at: string;
  expires_at: string;
};
type ProposeResult =
  | {
      status: "proposed";
      lesson: Lesson;
      provenance_gaps: string[];
      redactions?: { rule_id: string; count: number }[];
    }
  | { status: "rejected"; reasons: string[] };
type EligibilityCtx = {
  now: string;
  project_id: string;
  revoked: string[];
  current: {
    harness_build_sha: string | null;
    engine: string | null;
    dependency_lock_sha256: string | null;
  };
};
type EligibilityResult = { eligible: true } | { eligible: false; reasons: string[] };

interface SchemaLike {
  safeParse: (value: unknown) => { success: boolean };
}

type ProposeOpts = { production_identifiers?: string[] };
type ProposeFn = (episode: unknown, draft: LessonDraft, opts?: ProposeOpts) => ProposeResult;
type EligibilityFn = (lesson: Lesson, ctx: EligibilityCtx) => EligibilityResult;

const MOD_URL = new URL("../../src/evals/lesson.ts", import.meta.url).href;

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

const proposeLessonFromEpisode = (): ProposeFn => mod?.["proposeLessonFromEpisode"] as ProposeFn;
const lessonEligibility = (): EligibilityFn => mod?.["lessonEligibility"] as EligibilityFn;
const LessonSchema = (): SchemaLike => mod?.["LessonSchema"] as SchemaLike;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_N = "9".repeat(40);
const LOCK_SHA = "d".repeat(64);
const ASSERTION_DIGEST = "e".repeat(64);
const GRADER_BUILD = "f".repeat(64);
const ENGINE_VALUE = "llama.cpp-b4000";
const ENGINE_CHANGED = "llama.cpp-b5000";
const GH_TOKEN = "gh" + "p_" + "A".repeat(36);
const SK_TOKEN = "s" + "k-" + "b".repeat(32);
const PEM_HEADER = "-----BEGIN RSA PRIV" + "ATE KEY-----";

const CREATED_AT = "2026-11-01T00:00:00.000Z";
const EXPIRES_AT = "2027-02-01T00:00:00.000Z";
const NOW = "2026-12-01T00:00:00.000Z";

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

function attTimings(): JsonObject {
  return { queue_ms: null, exec_ms: null, check_ms: null, e2e_ms: null };
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
    timings: attTimings(),
    usage: { tokens: null, cost_usd: null, scope: "unknown", missing_reason: "x" },
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

function makeEpisode(overrides: JsonObject = {}): JsonObject {
  const episode = ep(overrides);
  const parsed = EpisodeSchema.safeParse(episode);
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.issues));
  }
  expect(parsed.success).toBe(true);
  return episode;
}

function signReceipt(claim: JsonObject): JsonObject {
  const unsigned = { ...claim, receipt_digest: null };
  return { ...unsigned, receipt_digest: receiptDigest(unsigned as ReceiptClaimBody) };
}

function hiddenReceipt(overrides: JsonObject = {}): JsonObject {
  return signReceipt({
    kind: "hidden_assertion",
    producer: "grader",
    sha: SHA_A,
    claimed_verdict: "pass",
    fail_reason: null,
    assertion_set_digest: ASSERTION_DIGEST,
    grader_build: GRADER_BUILD,
    per_check: [{ id: "c1", ok: true }],
    control_verdict: "pass",
    ...overrides,
  });
}

function weakReceipt(kind: string): JsonObject {
  return signReceipt({
    kind,
    producer: "worker",
    sha: SHA_A,
    claimed_verdict: "pass",
    fail_reason: null,
    assertion_set_digest: null,
    grader_build: null,
    per_check: null,
    control_verdict: null,
  });
}

function verifiedEpisode(overrides: JsonObject = {}): JsonObject {
  return makeEpisode({
    split: "dev",
    attempt_history: {
      status: "complete",
      reason: null,
      count: 1,
      count_basis: "claim_events",
    },
    attempts: [att(1, SHA_A)],
    final_sha: SHA_A,
    receipts: [hiddenReceipt()],
    harness_build: { sha: SHA_C },
    model_identity: modelIdentity({
      engine: { value: ENGINE_VALUE, provenance: "declared" },
    }),
    repo: { base_sha: null, dependency_lock_sha256: LOCK_SHA },
    ...overrides,
  });
}

function fullProvenanceEpisode(overrides: JsonObject = {}): JsonObject {
  return verifiedEpisode({
    model_identity: modelIdentity({
      engine: { value: ENGINE_VALUE, provenance: "declared" },
      effective: { value: "qwen3-coder", provenance: "acp_selected" },
    }),
    ...overrides,
  });
}

function unverifiedEpisode(): JsonObject {
  return makeEpisode({
    observed_outcome: { class: "model_failure", reason: "hidden_failed" },
  });
}

function draft(overrides: Partial<LessonDraft> = {}): LessonDraft {
  return {
    project_id: "penumbra",
    polarity: "positive",
    failure_signature: "bun test hangs on unclosed sqlite handle",
    root_cause: "db handle left open",
    procedure: ["close db in afterAll"],
    applicability: ["packages/core tests"],
    exclusions: ["daemon integration"],
    counterexample: null,
    created_at: CREATED_AT,
    expires_at: EXPIRES_AT,
    ...overrides,
  };
}

function proposedLesson(): Lesson {
  return lessonOf(proposeLessonFromEpisode()(fullProvenanceEpisode(), draft()));
}

function approvedLesson(): Lesson {
  return { ...proposedLesson(), review: "approved", approved_by: "human:alex" };
}

type CtxOpts = {
  now?: string;
  project_id?: string;
  revoked?: string[];
  engine?: string | null;
  harness_build_sha?: string | null;
  dependency_lock_sha256?: string | null;
};

function ctx(opts: CtxOpts = {}): EligibilityCtx {
  return {
    now: opts.now ?? NOW,
    project_id: opts.project_id ?? "penumbra",
    revoked: opts.revoked ?? [],
    current: {
      harness_build_sha: opts.harness_build_sha === undefined ? SHA_C : opts.harness_build_sha,
      engine: opts.engine === undefined ? ENGINE_VALUE : opts.engine,
      dependency_lock_sha256:
        opts.dependency_lock_sha256 === undefined ? LOCK_SHA : opts.dependency_lock_sha256,
    },
  };
}

function lessonOf(res: ProposeResult): Lesson {
  expect(res.status).toBe("proposed");
  if (res.status !== "proposed") {
    throw new Error("unreachable: status asserted proposed");
  }
  return res.lesson;
}

function expectProposedRejection(
  episode: JsonObject,
  d: LessonDraft,
  reason: string,
  opts?: ProposeOpts,
): void {
  const res = proposeLessonFromEpisode()(episode, d, opts);
  expect(res.status).toBe("rejected");
  if (res.status === "rejected") {
    expect(res.reasons).toContain(reason);
  }
}

test("propose: a verified episode yields a scoped advisory lesson", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const episode = verifiedEpisode();
  const lesson = lessonOf(proposeLessonFromEpisode()(episode, draft()));
  expect(lesson.review).toBe("proposed");
  expect(lesson.approved_by).toBeNull();
  expect(lesson.authority).toBe("advisory");
  expect(lesson.polarity).toBe("positive");
  const receipt = (episode.receipts as JsonObject[])[0];
  expect(lesson.source).toEqual({
    episode_id: "e1",
    family_id: "fam-h-t000000000000",
    final_sha: SHA_A,
    receipt_digests: [receipt?.["receipt_digest"] as string],
  });
  expect(lesson.scope).toEqual({
    project_id: "penumbra",
    harness_build_sha: SHA_C,
    engine: ENGINE_VALUE,
    dependency_lock_sha256: LOCK_SHA,
  });
  expect(lesson.lesson_id).toMatch(/^[0-9a-f]{64}$/);
});

test("propose: lesson_id is deterministic and content-derived", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const first = lessonOf(proposeLessonFromEpisode()(verifiedEpisode(), draft()));
  const second = lessonOf(proposeLessonFromEpisode()(verifiedEpisode(), draft()));
  expect(second.lesson_id).toBe(first.lesson_id);
  const changed = lessonOf(
    proposeLessonFromEpisode()(
      verifiedEpisode(),
      draft({ procedure: ["close db in afterAll", "also close the wal"] }),
    ),
  );
  expect(changed.lesson_id).not.toBe(first.lesson_id);
});

test("propose: contributions mirror assistance entries in order", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const episode = verifiedEpisode({
    assistance: [
      { kind: "fix_round", attempt_n: 1, ref: null },
      { kind: "teacher", attempt_n: 1, ref: "sess-9" },
    ],
  });
  const lesson = lessonOf(proposeLessonFromEpisode()(episode, draft()));
  expect(lesson.contributions).toEqual([
    { kind: "fix_round", attempt_n: 1 },
    { kind: "teacher", attempt_n: 1 },
  ]);
});

test("propose: unknown effective model identity is a provenance gap", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = proposeLessonFromEpisode()(verifiedEpisode(), draft());
  expect(res.status).toBe("proposed");
  if (res.status !== "proposed") {
    return;
  }
  expect(res.provenance_gaps).toEqual(["model_identity.effective"]);
});

test("propose: full provenance reports no gaps", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = proposeLessonFromEpisode()(fullProvenanceEpisode(), draft());
  expect(res.status).toBe("proposed");
  if (res.status !== "proposed") {
    return;
  }
  expect(res.provenance_gaps).toEqual([]);
});

test("propose: a missing harness build sha is a provenance gap", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = proposeLessonFromEpisode()(
    fullProvenanceEpisode({ harness_build: { sha: null, missing_reason: "x" } }),
    draft(),
  );
  expect(res.status).toBe("proposed");
  if (res.status !== "proposed") {
    return;
  }
  expect(res.provenance_gaps).toEqual(["harness_build"]);
});

test("propose: provenance gaps are reported sorted", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = proposeLessonFromEpisode()(
    verifiedEpisode({ harness_build: { sha: null, missing_reason: "x" } }),
    draft(),
  );
  expect(res.status).toBe("proposed");
  if (res.status !== "proposed") {
    return;
  }
  expect(res.provenance_gaps).toEqual(["harness_build", "model_identity.effective"]);
});

test("propose: positive drafts reject a null final_sha", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expectProposedRejection(verifiedEpisode({ final_sha: null }), draft(), "unverified_final_sha");
});

test("propose: positive drafts reject non-independent receipt kinds", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const episode = verifiedEpisode({
    receipts: [weakReceipt("self_report"), weakReceipt("llm_judge"), weakReceipt("reviewer")],
  });
  expectProposedRejection(episode, draft(), "unverified_final_sha");
});

test.each([
  { kind: "self_report" as const },
  { kind: "llm_judge" as const },
  { kind: "reviewer" as const },
  { kind: "schema_check" as const },
])("rejects a positive lesson verified only by a $kind receipt", ({ kind }) => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const episode = makeEpisode({
    split: "dev",
    attempt_history: {
      status: "complete",
      reason: null,
      count: 1,
      count_basis: "claim_events",
    },
    attempts: [att(1, SHA_A)],
    final_sha: SHA_A,
    receipts: [
      signReceipt({
        kind,
        producer: "grader",
        sha: SHA_A,
        claimed_verdict: "pass",
        fail_reason: null,
        assertion_set_digest: null,
        grader_build: null,
        per_check: null,
        control_verdict: "pass",
      }),
    ],
    harness_build: { sha: SHA_C },
    model_identity: modelIdentity({
      engine: { value: ENGINE_VALUE, provenance: "declared" },
    }),
    repo: { base_sha: null, dependency_lock_sha256: LOCK_SHA },
  });
  const res = proposeLessonFromEpisode()(episode, draft());
  expect(res).toEqual({ status: "rejected", reasons: ["unverified_final_sha"] });
});

test("propose: positive drafts reject a receipt bound to another sha", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const episode = verifiedEpisode({ receipts: [hiddenReceipt({ sha: SHA_B })] });
  expectProposedRejection(episode, draft(), "unverified_final_sha");
});

test("propose: positive drafts reject a failing hidden assertion", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const episode = verifiedEpisode({
    receipts: [
      hiddenReceipt({
        claimed_verdict: "fail",
        fail_reason: "hidden_failed",
        per_check: [{ id: "c1", ok: false }],
      }),
    ],
  });
  expectProposedRejection(episode, draft(), "unverified_final_sha");
});

test("propose: holdout episodes are rejected for both polarities", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const episode = verifiedEpisode({ split: "holdout" });
  for (const polarity of ["positive", "negative"] as const) {
    expectProposedRejection(episode, draft({ polarity }), "holdout_episode");
  }
});

test("propose: secrets in failure_signature are rejected", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expectProposedRejection(
    verifiedEpisode(),
    draft({ failure_signature: `leak ${SK_TOKEN} here` }),
    "secret_detected",
  );
});

test("propose: secrets in root_cause are rejected", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expectProposedRejection(
    verifiedEpisode(),
    draft({ root_cause: `token ${GH_TOKEN} leaked` }),
    "secret_detected",
  );
});

test("propose: secrets in procedure steps are rejected", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expectProposedRejection(
    verifiedEpisode(),
    draft({ procedure: ["close db in afterAll", PEM_HEADER] }),
    "secret_detected",
  );
});

test("propose: secrets in exclusions are rejected", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expectProposedRejection(
    verifiedEpisode(),
    draft({ exclusions: ["daemon integration", GH_TOKEN] }),
    "secret_detected",
  );
});

test("propose: secrets in applicability are rejected", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expectProposedRejection(
    verifiedEpisode(),
    draft({ applicability: ["packages/core tests", SK_TOKEN] }),
    "secret_detected",
  );
});

test("propose: secrets in counterexample are rejected", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expectProposedRejection(
    verifiedEpisode(),
    draft({ counterexample: SK_TOKEN }),
    "secret_detected",
  );
});

test("propose: receipt at non-final sha is excluded from receipt_digests", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const episode = makeEpisode({
    split: "dev",
    attempt_history: {
      status: "complete",
      reason: null,
      count: 1,
      count_basis: "claim_events",
    },
    attempts: [att(1, SHA_A)],
    final_sha: SHA_A,
    receipts: [hiddenReceipt(), hiddenReceipt({ sha: SHA_B })],
    harness_build: { sha: SHA_C },
    model_identity: modelIdentity({
      engine: { value: ENGINE_VALUE, provenance: "declared" },
    }),
    repo: { base_sha: null, dependency_lock_sha256: LOCK_SHA },
  });
  const res = proposeLessonFromEpisode()(episode, draft());
  expect(res.status).toBe("proposed");
  if (res.status !== "proposed") {
    return;
  }
  const baseReceipt = hiddenReceipt();
  const baseDigest = baseReceipt["receipt_digest"];
  expect(typeof baseDigest).toBe("string");
  expect(res.lesson.source.receipt_digests).toEqual([baseDigest as string]);
});

test("propose: invalid draft schema is rejected with invalid_draft_schema", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = proposeLessonFromEpisode()(verifiedEpisode(), draft({ project_id: "" }));
  expect(res).toEqual({ status: "rejected", reasons: ["invalid_draft_schema"] });
});

test("propose: draft with extra keys is rejected through the boundary", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const bad = { ...draft(), authority: "binding" };
  const res = proposeLessonFromEpisode()(verifiedEpisode(), bad);
  expect(res).toEqual({ status: "rejected", reasons: ["invalid_draft_schema"] });
});

test("propose: buildReceiptDigests includes only pass-only receipts", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const episode = makeEpisode({
    split: "dev",
    attempt_history: {
      status: "complete",
      reason: null,
      count: 1,
      count_basis: "claim_events",
    },
    attempts: [att(1, SHA_A)],
    final_sha: SHA_A,
    receipts: [
      hiddenReceipt(),
      hiddenReceipt({
        claimed_verdict: "fail",
        fail_reason: "hidden_failed",
        per_check: [{ id: "c1", ok: false }],
      }),
    ],
    harness_build: { sha: SHA_C },
    model_identity: modelIdentity({
      engine: { value: ENGINE_VALUE, provenance: "declared" },
    }),
    repo: { base_sha: null, dependency_lock_sha256: LOCK_SHA },
  });
  const res = proposeLessonFromEpisode()(episode, draft());
  expect(res.status).toBe("proposed");
  if (res.status !== "proposed") {
    return;
  }
  expect(res.lesson.source.receipt_digests).toHaveLength(1);
  const passingReceipt = hiddenReceipt();
  const passingDigest = passingReceipt["receipt_digest"];
  expect(typeof passingDigest).toBe("string");
  expect(res.lesson.source.receipt_digests).toEqual([passingDigest as string]);
});

test("propose: expiry equal to creation is rejected", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expectProposedRejection(verifiedEpisode(), draft({ expires_at: CREATED_AT }), "invalid_expiry");
});

test("propose: expiry before creation is rejected", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expectProposedRejection(
    verifiedEpisode(),
    draft({ expires_at: "2026-10-01T00:00:00.000Z" }),
    "invalid_expiry",
  );
});

test("propose: unparsed episode is rejected with invalid_episode_schema", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const unparsed = {
    episode_id: "bad",
    final_sha: SHA_A,
    receipts: [] as unknown[],
  };
  const res = proposeLessonFromEpisode()(unparsed, draft());
  expect(res.status).toBe("rejected");
  if (res.status === "rejected") {
    expect(res.reasons).toContain("invalid_episode_schema");
  }
});

test("propose: episode with receipt producer 'worker' is rejected", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const rawEpisode: JsonObject = {
    ...verifiedEpisode(),
    receipts: [
      signReceipt({
        kind: "hidden_assertion",
        producer: "worker",
        sha: SHA_A,
        claimed_verdict: "pass",
        fail_reason: null,
        assertion_set_digest: ASSERTION_DIGEST,
        grader_build: GRADER_BUILD,
        per_check: [{ id: "c1", ok: true }],
        control_verdict: "pass",
      }),
    ],
  };
  const res = proposeLessonFromEpisode()(rawEpisode, draft());
  expect(res.status).toBe("rejected");
  if (res.status === "rejected") {
    expect(res.reasons).toContain("invalid_episode_schema");
  }
});

test("propose: episode with receipt control_verdict 'fail' is rejected", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const rawEpisode: JsonObject = {
    ...verifiedEpisode(),
    receipts: [
      signReceipt({
        kind: "hidden_assertion",
        producer: "grader",
        sha: SHA_A,
        claimed_verdict: "pass",
        fail_reason: null,
        assertion_set_digest: ASSERTION_DIGEST,
        grader_build: GRADER_BUILD,
        per_check: [{ id: "c1", ok: true }],
        control_verdict: "fail",
      }),
    ],
  };
  const res = proposeLessonFromEpisode()(rawEpisode, draft());
  expect(res.status).toBe("rejected");
  if (res.status === "rejected") {
    expect(res.reasons).toContain("invalid_episode_schema");
  }
});

test("propose: negative drafts are proposed for unverified episodes", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const lesson = lessonOf(
    proposeLessonFromEpisode()(unverifiedEpisode(), draft({ polarity: "negative" })),
  );
  expect(lesson.polarity).toBe("negative");
  expect(lesson.source.receipt_digests).toEqual([]);
});

test("propose: negative drafts are proposed for verified episodes", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const lesson = lessonOf(
    proposeLessonFromEpisode()(verifiedEpisode(), draft({ polarity: "negative" })),
  );
  expect(lesson.polarity).toBe("negative");
});

test("LessonSchema: proposed lessons parse and authority stays advisory", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const lesson = lessonOf(proposeLessonFromEpisode()(verifiedEpisode(), draft()));
  const schema = LessonSchema();
  expect(schema.safeParse(lesson).success).toBe(true);
  expect(schema.safeParse({ ...lesson, grants_tools: ["Bash"] }).success).toBe(false);
  expect(schema.safeParse({ ...lesson, authority: "authoritative" }).success).toBe(false);
  expect(schema.safeParse({ ...lesson, review: "approved", approved_by: null }).success).toBe(
    false,
  );
  expect(
    schema.safeParse({ ...lesson, review: "approved", approved_by: "human:alex" }).success,
  ).toBe(true);
});

test("eligibility: an approved in-scope lesson is eligible", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expect(lessonEligibility()(approvedLesson(), ctx())).toEqual({ eligible: true });
});

test("eligibility: proposed lessons are not eligible", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = lessonEligibility()(proposedLesson(), ctx());
  expect(res.eligible).toBe(false);
  if (!res.eligible) {
    expect(res.reasons).toContain("not_approved");
  }
});

test("eligibility: expiry boundary and later both ineligible", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const lesson = approvedLesson();
  for (const now of [EXPIRES_AT, "2027-02-02T00:00:00.000Z"]) {
    const res = lessonEligibility()(lesson, ctx({ now }));
    expect(res.eligible).toBe(false);
    if (!res.eligible) {
      expect(res.reasons).toContain("expired");
    }
  }
});

test("eligibility: a different project is ineligible", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = lessonEligibility()(approvedLesson(), ctx({ project_id: "other" }));
  expect(res.eligible).toBe(false);
  if (!res.eligible) {
    expect(res.reasons).toContain("cross_project");
  }
});

test("eligibility: revoked source sha or receipt invalidates", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const lesson = approvedLesson();
  expect(lesson.source.receipt_digests).toHaveLength(1);
  const values = [lesson.source.final_sha, lesson.source.receipt_digests[0]].filter(
    (value): value is string => typeof value === "string",
  );
  expect(values).toHaveLength(2);
  for (const value of values) {
    const res = lessonEligibility()(lesson, ctx({ revoked: [value] }));
    expect(res.eligible).toBe(false);
    if (!res.eligible) {
      expect(res.reasons).toContain("source_revoked");
    }
  }
});

test("eligibility: changed engine or harness build invalidates", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const lesson = approvedLesson();
  const variants: CtxOpts[] = [{ engine: ENGINE_CHANGED }, { harness_build_sha: SHA_N }];
  for (const opts of variants) {
    const res = lessonEligibility()(lesson, ctx(opts));
    expect(res.eligible).toBe(false);
    if (!res.eligible) {
      expect(res.reasons).toContain("source_version_changed");
    }
  }
  const lockedLesson = lessonOf(
    proposeLessonFromEpisode()(
      verifiedEpisode({
        model_identity: modelIdentity({
          engine: { value: ENGINE_VALUE, provenance: "declared" },
          effective: { value: "qwen3-coder", provenance: "acp_selected" },
        }),
        repo: { base_sha: null, dependency_lock_sha256: LOCK_SHA },
      }),
      draft(),
    ),
  );
  const lockedLessonApproved = { ...lockedLesson, review: "approved", approved_by: "human:alex" };
  const lockedRes = lessonEligibility()(lockedLessonApproved, ctx({ engine: ENGINE_CHANGED }));
  expect(lockedRes.eligible).toBe(false);
  if (!lockedRes.eligible) {
    expect(lockedRes.reasons).toContain("source_version_changed");
  }
});

test("eligibility: changed dependency_lock_sha256 invalidates, same value stays eligible", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const LOCK_SHA_B = "b".repeat(64);
  const lockedLesson = lessonOf(
    proposeLessonFromEpisode()(
      verifiedEpisode({
        model_identity: modelIdentity({
          engine: { value: ENGINE_VALUE, provenance: "declared" },
          effective: { value: "qwen3-coder", provenance: "acp_selected" },
        }),
        repo: { base_sha: null, dependency_lock_sha256: LOCK_SHA },
      }),
      draft(),
    ),
  );
  const lockedLessonApproved = { ...lockedLesson, review: "approved", approved_by: "human:alex" };
  const diffLockRes = lessonEligibility()(
    lockedLessonApproved,
    ctx({ dependency_lock_sha256: LOCK_SHA_B }),
  );
  expect(diffLockRes.eligible).toBe(false);
  if (!diffLockRes.eligible) {
    expect(diffLockRes.reasons).toContain("source_version_changed");
  }
  const sameLockRes = lessonEligibility()(lockedLessonApproved, ctx());
  expect(sameLockRes).toEqual({ eligible: true });
});

test("eligibility: a null current engine is not a version change", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expect(lessonEligibility()(approvedLesson(), ctx({ engine: null }))).toEqual({
    eligible: true,
  });
});

test("eligibility: a null recorded scope engine stays eligible", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const proposed = lessonOf(
    proposeLessonFromEpisode()(verifiedEpisode({ model_identity: modelIdentity() }), draft()),
  );
  expect(proposed.scope.engine).toBeNull();
  const lesson = { ...proposed, review: "approved", approved_by: "human:alex" };
  expect(lessonEligibility()(lesson, ctx())).toEqual({ eligible: true });
});

test("eligibility: negative lessons are ineligible even when approved", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const negative = lessonOf(
    proposeLessonFromEpisode()(verifiedEpisode(), draft({ polarity: "negative" })),
  );
  const lesson = { ...negative, review: "approved", approved_by: "human:alex" };
  const res = lessonEligibility()(lesson, ctx());
  expect(res.eligible).toBe(false);
  if (!res.eligible) {
    expect(res.reasons).toContain("negative_example");
  }
});

test("eligibility: reasons accumulate sorted", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = lessonEligibility()(
    proposedLesson(),
    ctx({ project_id: "other", now: "2027-03-01T00:00:00.000Z", engine: ENGINE_CHANGED }),
  );
  expect(res).toEqual({
    eligible: false,
    reasons: ["cross_project", "expired", "not_approved", "source_version_changed"],
  });
});

test.each([
  { kind: "self_report", title: "self_report" },
  { kind: "llm_judge", title: "llm_judge" },
  { kind: "reviewer", title: "reviewer" },
  { kind: "schema_check", title: "schema_check" },
])("keeps a $kind companion receipt out of receipt_digests", ({ kind, title }) => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const finalSha = SHA_A;
  const episode = makeEpisode({
    split: "dev",
    attempt_history: {
      status: "complete",
      reason: null,
      count: 1,
      count_basis: "claim_events",
    },
    attempts: [att(1, finalSha)],
    final_sha: finalSha,
    receipts: [
      hiddenReceipt(),
      signReceipt({
        kind,
        producer: "grader",
        sha: finalSha,
        claimed_verdict: "pass",
        fail_reason: null,
        assertion_set_digest: null,
        grader_build: null,
        per_check: null,
        control_verdict: "pass",
      }),
    ],
    harness_build: { sha: SHA_C },
    model_identity: modelIdentity({
      engine: { value: ENGINE_VALUE, provenance: "declared" },
    }),
    repo: { base_sha: null, dependency_lock_sha256: LOCK_SHA },
  });
  const res = proposeLessonFromEpisode()(episode, draft());
  expect(res.status).toBe("proposed");
  if (res.status !== "proposed") {
    return;
  }
  const hidden = hiddenReceipt();
  const hiddenDigest = hidden["receipt_digest"];
  expect(typeof hiddenDigest).toBe("string");
  expect(res.lesson.source.receipt_digests).toEqual([hiddenDigest as string]);
});

test("propose: buildReceiptDigests recomputes digest for unsigned receipts", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const finalSha = SHA_A;
  const unsignedHidden: JsonObject = { ...hiddenReceipt(), receipt_digest: null };
  const episode = makeEpisode({
    split: "dev",
    attempt_history: {
      status: "complete",
      reason: null,
      count: 1,
      count_basis: "claim_events",
    },
    attempts: [att(1, finalSha)],
    final_sha: finalSha,
    receipts: [unsignedHidden],
    harness_build: { sha: SHA_C },
    model_identity: modelIdentity({
      engine: { value: ENGINE_VALUE, provenance: "declared" },
    }),
    repo: { base_sha: null, dependency_lock_sha256: LOCK_SHA },
  });
  const res = proposeLessonFromEpisode()(episode, draft());
  expect(res.status).toBe("proposed");
  if (res.status !== "proposed") {
    return;
  }
  expect(res.lesson.source.receipt_digests).toHaveLength(1);
  const expectedUnsigned = receiptDigest(unsignedHidden as ReceiptClaimBody);
  expect(res.lesson.source.receipt_digests).toEqual([expectedUnsigned]);
});

test("propose: production identifiers in drafts are redacted before the lesson is built", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = proposeLessonFromEpisode()(
    verifiedEpisode(),
    draft({ root_cause: "pool exhausted on db-prod-7.acme.example" }),
    { production_identifiers: ["db-prod-7.acme.example"] },
  );
  expect(res.status).toBe("proposed");
  if (res.status !== "proposed") {
    return;
  }
  expect(res.lesson.root_cause).not.toContain("db-prod-7");
  expect(res.lesson.root_cause).toContain("[REDACTED:production_identifier]");
  expect(res.redactions).toEqual([{ rule_id: "production_identifier", count: 1 }]);
});

test("propose: lesson_id digests the redacted draft body", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const viaOpts = lessonOf(
    proposeLessonFromEpisode()(
      verifiedEpisode(),
      draft({ root_cause: "pool exhausted on db-prod-7.acme.example" }),
      { production_identifiers: ["db-prod-7.acme.example"] },
    ),
  );
  const preRedacted = lessonOf(
    proposeLessonFromEpisode()(
      verifiedEpisode(),
      draft({ root_cause: "pool exhausted on [REDACTED:production_identifier]" }),
    ),
  );
  expect(viaOpts.lesson_id).toBe(preRedacted.lesson_id);
});

test("propose: home paths in drafts are redacted with no opts", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = proposeLessonFromEpisode()(
    verifiedEpisode(),
    draft({ procedure: ["/Users/alex/repo"] }),
  );
  expect(res.status).toBe("proposed");
  if (res.status !== "proposed") {
    return;
  }
  expect(res.lesson.procedure[0]?.startsWith("~/repo")).toBe(true);
  expect(res.redactions).toEqual([{ rule_id: "home_path", count: 1 }]);
});

test("propose: a clean draft reports no redactions", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const res = proposeLessonFromEpisode()(verifiedEpisode(), draft());
  expect(res.status).toBe("proposed");
  if (res.status !== "proposed") {
    return;
  }
  expect(res.redactions).toEqual([]);
});

test("propose: invalid redaction options are rejected", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const badType = proposeLessonFromEpisode()(verifiedEpisode(), draft(), {
    production_identifiers: [42],
  } as unknown as ProposeOpts);
  expect(badType).toEqual({ status: "rejected", reasons: ["invalid_redaction_options"] });
  const unknownKey = proposeLessonFromEpisode()(verifiedEpisode(), draft(), {
    production_identifiers: ["db-prod-7.acme.example"],
    extra_rule: true,
  } as unknown as ProposeOpts);
  expect(unknownKey).toEqual({ status: "rejected", reasons: ["invalid_redaction_options"] });
});

test("propose: a secret listed as an identifier is still rejected", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expectProposedRejection(
    verifiedEpisode(),
    draft({ root_cause: `leaked ${SK_TOKEN} in config` }),
    "secret_detected",
    { production_identifiers: [SK_TOKEN] },
  );
});
