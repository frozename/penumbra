import { canonicalJson } from "@penumbra/core/evals/canonical";
import {
  assertionSetDigest,
  bundleContentDigest,
  type FixturePublic,
  FixturePublicSchema,
  type HoldoutBundle,
  type HoldoutLock,
  type HoldoutLockEntry,
} from "@penumbra/core/evals/fixture";
import { computeLockDigest } from "@penumbra/core/evals/holdout";
import {
  EpisodeSchema,
  type ReceiptClaimBody,
  ReceiptClaimSchema,
  receiptDigest,
} from "@penumbra/core/evals/manifest";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HoldoutStoreError } from "./holdout-store.js";

// verify.ts does not exist yet: the P10 part-2 surface is declared
// structurally below and the module is loaded dynamically so every case
// fails on the `expect(mod).not.toBeNull()` assertion at RED time instead
// of on a missing import (the same pattern holdout-store.test.ts uses).
type JsonObject = Record<string, unknown>;

type VerifyResultLike =
  | {
      status: "verified";
      verdict: "pass" | "fail";
      fail_reason: string | null;
      sha: string;
      control_verdict: "pass";
    }
  | { status: "rejected"; reason: string; detail?: string };

interface GradeInputLike {
  fixture_ref: { family_id: string; variant_id: string };
  base_sha: string;
  final_sha: string;
}

interface VerifyCtx {
  store: { readEntry(entry: HoldoutLockEntry): Promise<HoldoutBundle> };
  scratch: { buildBase(files: Record<string, string>): Promise<string> };
  controls: {
    ensure(
      ref: { family_id: string; variant_id: string },
      bundle: HoldoutBundle,
    ): Promise<{ ok: boolean }>;
  };
  grade(input: GradeInputLike, bundle: HoldoutBundle): Promise<unknown>;
  allowlist: { builds: { id: string; note: string }[] };
  buildId: string;
  publicFixtures: { fixture: FixturePublic; bundle: HoldoutBundle }[];
  lock: HoldoutLock;
}

interface VerifyApi {
  verifyReceipt(claim: unknown, episode: unknown, ctx: VerifyCtx): Promise<VerifyResultLike>;
  receiptVerifier(ctx: VerifyCtx): {
    verify(claim: unknown, episode: unknown): Promise<VerifyResultLike>;
  };
  loadGraderAllowlist(path?: string): { builds: { id: string; note: string }[] };
  GraderAllowlistSchema: { safeParse(value: unknown): { success: boolean } };
  DEFAULT_ALLOWLIST_PATH: string;
}

const VERIFY_URL = new URL("./verify.ts", import.meta.url).href;

async function loadVerify(): Promise<VerifyApi> {
  const mod = (await import(VERIFY_URL).catch(() => null)) as VerifyApi | null;
  expect(mod).not.toBeNull();
  return mod!;
}

// --- fixtures -----------------------------------------------------------------

const BASE = "a".repeat(40);
const FINAL = "c".repeat(40);
const LATER_BASE = "d".repeat(40);
const BUILD = "9".repeat(64);
const OTHER_BUILD = "8".repeat(64);
const FAMILY = "fam-syn-verify-target";
const ROOT: HoldoutLockEntry["root"] = { kind: "synthetic", id: "verify-target" };

type BundleAssertion = HoldoutBundle["assertions"][number];

function probe(id: string, expectValue: number): BundleAssertion {
  return { kind: "probe", id, module: "src/a.ts", export: "a", input: null, expect: expectValue };
}

function mkBundle(variant: string, assertions: HoldoutBundle["assertions"]): HoldoutBundle {
  return {
    schema_version: 1,
    family_id: FAMILY,
    variant_id: variant,
    repo_files: { "src/a.ts": "export const a = 1;\n" },
    assertions,
    patches: { good: "g", bad: ["b"] },
    mutants: [],
  };
}

const A = mkBundle("v1", [probe("c1", 1), probe("c2", 2)]);
const B = mkBundle("v2", [probe("c1", 7)]);
const C = mkBundle("v3", [probe("c1", 9), probe("c9", 9)]);

function mkEntry(bundle: HoldoutBundle): HoldoutLockEntry {
  return {
    family_id: bundle.family_id,
    variant_id: bundle.variant_id,
    root: ROOT,
    failure_type: null,
    synthetic: true,
    expect_blocked: false,
    base_sha: BASE,
    task_digest: "b".repeat(64),
    source_root_handoff_digests: [],
    content_digest: bundleContentDigest(bundle),
    assertion_set_digest: assertionSetDigest(bundle),
  };
}

const eA = mkEntry(A);
const eB = mkEntry(B);
const LOCK: HoldoutLock = {
  schema_version: 1,
  entries: [eA, eB],
  digest: computeLockDigest([eA, eB]),
};
const EMPTY_LOCK: HoldoutLock = {
  schema_version: 1,
  entries: [],
  digest: computeLockDigest([]),
};

function sign(body: ReceiptClaimBody): ReceiptClaimBody {
  const signed: ReceiptClaimBody = {
    ...body,
    receipt_digest: receiptDigest({ ...body, receipt_digest: null }),
  };
  const parsed = ReceiptClaimSchema.safeParse(signed);
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.issues));
  }
  expect(parsed.success).toBe(true);
  return signed;
}

function claimBody(
  bundle: HoldoutBundle,
  overrides: Partial<ReceiptClaimBody> = {},
): ReceiptClaimBody {
  return {
    kind: "hidden_assertion",
    sha: FINAL,
    producer: "grader",
    claimed_verdict: "pass",
    fail_reason: null,
    assertion_set_digest: assertionSetDigest(bundle),
    grader_build: BUILD,
    per_check: bundle.assertions.map((assertion) => ({ id: assertion.id, ok: true })),
    control_verdict: "pass",
    receipt_digest: null,
    ...overrides,
  };
}

function passClaim(
  bundle: HoldoutBundle,
  overrides: Partial<ReceiptClaimBody> = {},
): ReceiptClaimBody {
  return sign(claimBody(bundle, overrides));
}

function failClaim(bundle: HoldoutBundle): ReceiptClaimBody {
  return sign(
    claimBody(bundle, {
      claimed_verdict: "fail",
      fail_reason: "hidden_failed",
      per_check: bundle.assertions.map((assertion, index) => ({
        id: assertion.id,
        ok: index === 0,
      })),
    }),
  );
}

// --- episode builder (shape copied from packages/core/test/evals/aggregate.test.ts) ---

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

function makeEpisode(overrides: JsonObject = {}, expectValid = true): JsonObject {
  const episode: JsonObject = {
    schema_version: 1,
    episode_id: "e1",
    family_id: FAMILY,
    fixture_ref: { family_id: FAMILY, variant_id: "v1" },
    split: "holdout",
    design: "controlled",
    failure_type: null,
    task_digest: null,
    task_refs: { issues: [], bundle_ids: [] },
    repo: { base_sha: BASE, dependency_lock_sha256: null },
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
    attempts: [att(1, FINAL)],
    assistance: [],
    final_sha: FINAL,
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
  if (expectValid) {
    expect(parsed.success).toBe(true);
  }
  return episode;
}

// --- ctx stubs -----------------------------------------------------------------

const ALL_GRADE_INPUTS: GradeInputLike[] = [];

interface CtxHandle {
  ctx: VerifyCtx;
  reads: HoldoutLockEntry[];
  builds: Record<string, string>[];
  order: string[];
  gradeInputs: GradeInputLike[];
}

interface CtxOptions {
  lock?: HoldoutLock;
  bundles?: HoldoutBundle[];
  readEntry?: (entry: HoldoutLockEntry) => Promise<HoldoutBundle>;
  buildBaseSha?: string;
  controlOk?: boolean;
  gradeResult?: unknown;
  allowlistBuilds?: { id: string; note: string }[];
  buildId?: string;
  publicFixtures?: { fixture: FixturePublic; bundle: HoldoutBundle }[];
}

function mkCtx(opts: CtxOptions = {}): CtxHandle {
  const reads: HoldoutLockEntry[] = [];
  const builds: Record<string, string>[] = [];
  const order: string[] = [];
  const gradeInputs: GradeInputLike[] = [];
  const bundles = opts.bundles ?? [A, B];
  const ctx: VerifyCtx = {
    store: {
      readEntry:
        opts.readEntry ??
        ((entry: HoldoutLockEntry): Promise<HoldoutBundle> => {
          reads.push(entry);
          const bundle = bundles.find(
            (candidate) => bundleContentDigest(candidate) === entry.content_digest,
          );
          if (bundle === undefined) {
            return Promise.reject(
              new HoldoutStoreError("bundle_missing", `no bundle matches ${entry.content_digest}`),
            );
          }
          return Promise.resolve(bundle);
        }),
    },
    scratch: {
      buildBase: (files: Record<string, string>): Promise<string> => {
        builds.push(files);
        return Promise.resolve(opts.buildBaseSha ?? BASE);
      },
    },
    controls: {
      ensure: (): Promise<{ ok: boolean }> => {
        order.push("ensure");
        return Promise.resolve({ ok: opts.controlOk ?? true });
      },
    },
    grade: (input: GradeInputLike): Promise<unknown> => {
      order.push("grade");
      gradeInputs.push(input);
      ALL_GRADE_INPUTS.push(input);
      const result = opts.gradeResult;
      return Promise.resolve(
        typeof result === "function" ? (result as () => unknown)() : (result ?? passClaim(A)),
      );
    },
    allowlist: { builds: opts.allowlistBuilds ?? [{ id: BUILD, note: "test" }] },
    buildId: opts.buildId ?? BUILD,
    publicFixtures: opts.publicFixtures ?? [],
    lock: opts.lock ?? LOCK,
  };
  return { ctx, reads, builds, order, gradeInputs };
}

function publicFixture(split: "train" | "dev" | "holdout"): FixturePublic {
  return {
    schema_version: 1,
    family_id: FAMILY,
    variant_id: "v1",
    root: ROOT,
    reconstructs: null,
    failure_type: null,
    split,
    synthetic: true,
    base_sha: BASE,
    task_digest: "b".repeat(64),
    source_root_handoff_digests: [],
    expect_blocked: false,
    hidden_ref: { assertion_set_digest: assertionSetDigest(A) },
    content_digest: bundleContentDigest(A),
  };
}

function expectRejected(res: VerifyResultLike, reason: string, detail?: string): void {
  expect(res.status).toBe("rejected");
  if (res.status !== "rejected") {
    return;
  }
  expect(res.reason).toBe(reason);
  if (detail !== undefined) {
    expect(res.detail).toBe(detail);
  }
}

// --- cases ---------------------------------------------------------------------

test("a valid holdout receipt verifies end-to-end against the lock", async () => {
  const claim = passClaim(A);
  const episode = makeEpisode();
  const { ctx, reads, builds, order, gradeInputs } = mkCtx();
  const mod = await loadVerify();
  const res = await mod.verifyReceipt(claim, episode, ctx);
  expect(res).toEqual({
    status: "verified",
    verdict: "pass",
    fail_reason: null,
    sha: FINAL,
    control_verdict: "pass",
  });
  expect(order).toEqual(["ensure", "grade"]);
  expect(gradeInputs).toHaveLength(1);
  expect(gradeInputs[0]).toEqual({
    fixture_ref: { family_id: FAMILY, variant_id: "v1" },
    base_sha: BASE,
    final_sha: FINAL,
  });
  expect(reads).toHaveLength(1);
  expect(canonicalJson(reads[0])).toBe(canonicalJson(eA));
  expect(builds).toHaveLength(1);
  expect(builds[0]).toEqual(A.repo_files);
});

test("a claim verified against a different fixture variant is rejected", async () => {
  const claim = passClaim(A);
  const episode = makeEpisode({ fixture_ref: { family_id: FAMILY, variant_id: "v2" } });
  const { ctx, gradeInputs } = mkCtx();
  const mod = await loadVerify();
  const res = await mod.verifyReceipt(claim, episode, ctx);
  expectRejected(res, "fixture_mismatch");
  expect(gradeInputs).toHaveLength(0);
});

test("a claim carrying a foreign assertion set digest is a fixture mismatch", async () => {
  const claim = passClaim(A, { assertion_set_digest: assertionSetDigest(C) });
  const episode = makeEpisode();
  const { ctx, reads, gradeInputs } = mkCtx();
  const mod = await loadVerify();
  const res = await mod.verifyReceipt(claim, episode, ctx);
  expectRejected(res, "fixture_mismatch");
  for (const read of reads) {
    expect(read.assertion_set_digest).not.toBe(assertionSetDigest(C));
    expect(read.content_digest).not.toBe(bundleContentDigest(C));
  }
  expect(gradeInputs).toHaveLength(0);
});

test("a fixture ref outside the lock and public fixtures is unknown", async () => {
  const claim = passClaim(A);
  const episode = makeEpisode({ fixture_ref: { family_id: FAMILY, variant_id: "v3" } });
  const { ctx, reads, gradeInputs } = mkCtx();
  const mod = await loadVerify();
  const res = await mod.verifyReceipt(claim, episode, ctx);
  expectRejected(res, "fixture_unknown");
  expect(reads).toHaveLength(0);
  expect(gradeInputs).toHaveLength(0);
});

test("a claim sha that differs from the episode final sha is rejected", async () => {
  const claim = passClaim(A, { sha: "e".repeat(40) });
  const episode = makeEpisode();
  const { ctx, gradeInputs } = mkCtx();
  const mod = await loadVerify();
  const res = await mod.verifyReceipt(claim, episode, ctx);
  expectRejected(res, "sha_mismatch");
  expect(gradeInputs).toHaveLength(0);
});

test("a regrade that disagrees with the claim verdict is nondeterministic", async () => {
  const original = failClaim(A);
  const edited: ReceiptClaimBody = {
    ...original,
    claimed_verdict: "pass",
    fail_reason: null,
    per_check: (original.per_check ?? []).map((check) => ({ ...check, ok: true })),
  };
  const resigned = sign(edited);
  const stale: ReceiptClaimBody = { ...edited };
  const episode = makeEpisode();
  const { ctx, gradeInputs } = mkCtx({ gradeResult: original });
  const mod = await loadVerify();
  const res = await mod.verifyReceipt(resigned, episode, ctx);
  expect(res).toEqual({
    status: "verified",
    verdict: "fail",
    fail_reason: "nondeterministic",
    sha: FINAL,
    control_verdict: "pass",
  });
  expect(res.status).toBe("verified");

  const rejected = await mod.verifyReceipt(stale, episode, ctx);
  expectRejected(rejected, "malformed");
  expect(gradeInputs).toHaveLength(1);
});

test("grader_build must be allowlisted and match the running build", async () => {
  const claim = passClaim(A, { grader_build: OTHER_BUILD });
  const episode = makeEpisode();
  const first = mkCtx();
  const second = mkCtx({
    allowlistBuilds: [
      { id: BUILD, note: "test" },
      { id: OTHER_BUILD, note: "test" },
    ],
  });
  const mod = await loadVerify();
  expectRejected(
    await mod.verifyReceipt(claim, episode, first.ctx),
    "grader_build_not_allowlisted",
  );
  expectRejected(await mod.verifyReceipt(claim, episode, second.ctx), "grader_build_mismatch");
});

test("an unsigned receipt is rejected", async () => {
  const unsigned: ReceiptClaimBody = { ...passClaim(A), receipt_digest: null };
  const episode = makeEpisode();
  const { ctx, gradeInputs } = mkCtx();
  const mod = await loadVerify();
  expectRejected(await mod.verifyReceipt(unsigned, episode, ctx), "receipt_digest_mismatch");
  expect(gradeInputs).toHaveLength(0);
});

test("store errors surface as rejection reasons", async () => {
  const claim = passClaim(A);
  const episode = makeEpisode();
  const { ctx } = mkCtx({
    readEntry: () => Promise.reject(new HoldoutStoreError("unseal_required", "x")),
  });
  const mod = await loadVerify();
  expectRejected(await mod.verifyReceipt(claim, episode, ctx), "unseal_required");
});

test("a public dev fixture verifies without touching the holdout store", async () => {
  const fixture = publicFixture("dev");
  expect(FixturePublicSchema.safeParse(fixture).success).toBe(true);
  const claim = passClaim(A);
  const episode = makeEpisode({ split: "dev" });
  const { ctx, reads, gradeInputs } = mkCtx({
    lock: EMPTY_LOCK,
    publicFixtures: [{ fixture, bundle: A }],
  });
  const mod = await loadVerify();
  const res = await mod.verifyReceipt(claim, episode, ctx);
  expect(res).toEqual({
    status: "verified",
    verdict: "pass",
    fail_reason: null,
    sha: FINAL,
    control_verdict: "pass",
  });
  expect(reads).toHaveLength(0);
  expect(gradeInputs).toHaveLength(1);
});

test("a public fixture bundle that fails its content digest is rejected", async () => {
  const fixture = publicFixture("dev");
  const tampered: HoldoutBundle = { ...A, mutants: ["tampered-mutant"] };
  const claim = passClaim(A);
  const episode = makeEpisode({ split: "dev" });
  const { ctx, reads, gradeInputs } = mkCtx({
    lock: EMPTY_LOCK,
    publicFixtures: [{ fixture, bundle: tampered }],
  });
  const mod = await loadVerify();
  expectRejected(await mod.verifyReceipt(claim, episode, ctx), "content_digest_mismatch");
  expect(reads).toHaveLength(0);
  expect(gradeInputs).toHaveLength(0);
});

test("a public fixture from another split does not resolve", async () => {
  const fixture = publicFixture("train");
  const claim = passClaim(A);
  const episode = makeEpisode({ split: "dev" });
  const { ctx, reads, gradeInputs } = mkCtx({
    lock: EMPTY_LOCK,
    publicFixtures: [{ fixture, bundle: A }],
  });
  const mod = await loadVerify();
  expectRejected(await mod.verifyReceipt(claim, episode, ctx), "fixture_unknown");
  expect(reads).toHaveLength(0);
  expect(gradeInputs).toHaveLength(0);
});

test("non-independent receipt kinds are rejected", async () => {
  const base = {
    sha: FINAL,
    producer: "worker",
    claimed_verdict: "pass",
    fail_reason: null,
    assertion_set_digest: null,
    grader_build: null,
    per_check: null,
    control_verdict: null,
    receipt_digest: null,
  } as const;
  const claims: ReceiptClaimBody[] = [];
  for (const kind of ["self_report", "llm_judge"] as const) {
    const claim: ReceiptClaimBody = { ...base, kind };
    expect(ReceiptClaimSchema.safeParse(claim).success).toBe(true);
    claims.push(claim);
  }
  const episode = makeEpisode();
  const mod = await loadVerify();
  for (const claim of claims) {
    const { ctx, gradeInputs } = mkCtx();
    expectRejected(await mod.verifyReceipt(claim, episode, ctx), "not_independent_kind");
    expect(gradeInputs).toHaveLength(0);
  }
});

test("a nondeterministic grader stub yields a verified nondeterministic failure", async () => {
  let now = 0;
  const verdictAt = (): "pass" | "fail" => (now % 2 === 0 ? "pass" : "fail");
  const stubClaim = (): ReceiptClaimBody => (verdictAt() === "pass" ? passClaim(A) : failClaim(A));
  const claim = stubClaim();
  now = 1;
  const episode = makeEpisode();
  const { ctx } = mkCtx({ gradeResult: stubClaim() });
  const mod = await loadVerify();
  const res = await mod.verifyReceipt(claim, episode, ctx);
  expect(res).toEqual({
    status: "verified",
    verdict: "fail",
    fail_reason: "nondeterministic",
    sha: FINAL,
    control_verdict: "pass",
  });
});

test("a failed control qualification rejects the regrade", async () => {
  const claim = passClaim(A);
  const episode = makeEpisode();
  const { ctx, order, gradeInputs } = mkCtx({ controlOk: false });
  const mod = await loadVerify();
  expectRejected(await mod.verifyReceipt(claim, episode, ctx), "regrade_mismatch", "control");
  expect(order).toEqual(["ensure"]);
  expect(gradeInputs).toHaveLength(0);
});

test("an episode base sha that differs from the fixture base is rejected", async () => {
  const claim = passClaim(A);
  const laterBaseEpisode = makeEpisode({
    repo: { base_sha: LATER_BASE, dependency_lock_sha256: null },
  });
  const nullBaseEpisode = makeEpisode({ repo: { base_sha: null, dependency_lock_sha256: null } });
  const { ctx, gradeInputs } = mkCtx();
  const mod = await loadVerify();
  expectRejected(await mod.verifyReceipt(claim, laterBaseEpisode, ctx), "base_mismatch");
  expectRejected(await mod.verifyReceipt(claim, nullBaseEpisode, ctx), "base_mismatch");
  expect(gradeInputs).toHaveLength(0);
});

test("a rebuilt base that does not match the fixture base rejects the regrade", async () => {
  const claim = passClaim(A);
  const episode = makeEpisode();
  const { ctx, builds, gradeInputs } = mkCtx({ buildBaseSha: LATER_BASE });
  const mod = await loadVerify();
  expectRejected(await mod.verifyReceipt(claim, episode, ctx), "regrade_mismatch", "base_build");
  expect(builds).toHaveLength(1);
  expect(builds[0]).toEqual(A.repo_files);
  expect(gradeInputs).toHaveLength(0);
});

test("schema-invalid episodes and claims are malformed", async () => {
  const badEpisode = makeEpisode({ final_sha: "f".repeat(40) }, false);
  expect(EpisodeSchema.safeParse(badEpisode).success).toBe(false);
  const claim = passClaim(A, { sha: "f".repeat(40) });
  const episode = makeEpisode();
  const { ctx, gradeInputs } = mkCtx();
  const mod = await loadVerify();
  expectRejected(await mod.verifyReceipt(claim, badEpisode, ctx), "malformed");
  expectRejected(await mod.verifyReceipt({}, episode, ctx), "malformed");
  expect(gradeInputs).toHaveLength(0);
});

test("an episode without a fixture ref is rejected", async () => {
  const episode = makeEpisode({ fixture_ref: null, design: "observational", recipe_id: null });
  const claim = passClaim(A);
  const { ctx, gradeInputs } = mkCtx();
  const mod = await loadVerify();
  expectRejected(await mod.verifyReceipt(claim, episode, ctx), "no_fixture_ref");
  expect(gradeInputs).toHaveLength(0);
});

test("an ungradeable regrade rejects with detail", async () => {
  const claim = passClaim(A);
  const episode = makeEpisode();
  const { ctx } = mkCtx({ gradeResult: { ungradeable: "final_missing" } });
  const mod = await loadVerify();
  expectRejected(
    await mod.verifyReceipt(claim, episode, ctx),
    "regrade_mismatch",
    "ungradeable:final_missing",
  );
});

test("grader allowlist file, schema, and build-id self-reference guard", async () => {
  expect(existsSync(join(import.meta.dir, "grader-allowlist.json"))).toBe(true);
  const mod = await loadVerify();
  const loaded = mod.loadGraderAllowlist();
  expect(Array.isArray(loaded.builds)).toBe(true);
  expect(typeof mod.DEFAULT_ALLOWLIST_PATH).toBe("string");
  expect(mod.DEFAULT_ALLOWLIST_PATH.endsWith("grader-allowlist.json")).toBe(true);
  expect(
    mod.GraderAllowlistSchema.safeParse({ builds: [{ id: BUILD, note: "test" }] }).success,
  ).toBe(true);
  expect(
    mod.GraderAllowlistSchema.safeParse({ builds: [{ id: "nothex", note: "" }] }).success,
  ).toBe(false);
  expect(mod.GraderAllowlistSchema.safeParse({ builds: [], unexpected: true }).success).toBe(false);
  const source = readFileSync(join(import.meta.dir, "verify.ts"), "utf8");
  expect(source).not.toMatch(/import[^;]*grader-allowlist/);
});

test("receiptVerifier matches verifyReceipt", async () => {
  const claim = passClaim(A);
  const episode = makeEpisode();
  const { ctx } = mkCtx();
  const mod = await loadVerify();
  const direct = await mod.verifyReceipt(claim, episode, ctx);
  const via = await mod.receiptVerifier(ctx).verify(claim, episode);
  expect(via).toEqual(direct);
  expect(direct).toEqual({
    status: "verified",
    verdict: "pass",
    fail_reason: null,
    sha: FINAL,
    control_verdict: "pass",
  });
});

test("every recorded regrade input carries the verified base sha", async () => {
  await loadVerify();
  for (const input of ALL_GRADE_INPUTS) {
    expect(input.base_sha).toBe(BASE);
  }
});
