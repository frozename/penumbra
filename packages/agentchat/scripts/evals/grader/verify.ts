import { canonicalJson } from "@penumbra/core/evals/canonical";
import {
  bundleContentDigest,
  type FixturePublic,
  type HoldoutBundle,
  type HoldoutLock,
  type HoldoutLockEntry,
} from "@penumbra/core/evals/fixture";
import {
  type Episode,
  EpisodeSchema,
  type ReceiptClaimBody,
  ReceiptClaimSchema,
  receiptDigest,
  Sha256HexSchema,
} from "@penumbra/core/evals/manifest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import type { FixtureRef } from "./control.js";
import type { GradeInput, GradeResult } from "./grade.js";
import type { GraderScratch } from "./scratch.js";

import {
  type HoldoutStore,
  HoldoutStoreError,
  type HoldoutStoreErrorCode,
} from "./holdout-store.js";

// Loaded at runtime, never statically, so the allowlist stays out of the
// graderBuildId closure. Only the controller appends build ids at land time.
export const DEFAULT_ALLOWLIST_PATH = fileURLToPath(
  new URL("./grader-allowlist.json", import.meta.url),
);

export const GraderAllowlistSchema = z.strictObject({
  builds: z.array(z.strictObject({ id: Sha256HexSchema, note: z.string() })),
});

export type GraderAllowlist = z.infer<typeof GraderAllowlistSchema>;

export function loadGraderAllowlist(path: string = DEFAULT_ALLOWLIST_PATH): GraderAllowlist {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return GraderAllowlistSchema.parse(raw);
}

export type VerifyRejectReason =
  | "malformed"
  | "not_independent_kind"
  | "no_fixture_ref"
  | "fixture_unknown"
  | "base_mismatch"
  | "fixture_mismatch"
  | "sha_mismatch"
  | "grader_build_not_allowlisted"
  | "grader_build_mismatch"
  | "receipt_digest_mismatch"
  | "regrade_mismatch"
  | HoldoutStoreErrorCode;

export type VerifyResult =
  | {
      status: "verified";
      verdict: "pass" | "fail";
      fail_reason: ReceiptClaimBody["fail_reason"];
      sha: string;
      control_verdict: "pass";
    }
  | { status: "rejected"; reason: VerifyRejectReason; detail?: string };

export interface PublicFixtureSource {
  fixture: FixturePublic;
  bundle: HoldoutBundle | null;
}

export interface VerifyContext {
  lock: HoldoutLock;
  publicFixtures: readonly PublicFixtureSource[];
  store: Pick<HoldoutStore, "readEntry">;
  scratch: Pick<GraderScratch, "buildBase">;
  controls: { ensure(ref: FixtureRef, bundle: HoldoutBundle): Promise<{ ok: boolean }> };
  allowlist: GraderAllowlist;
  grade: (input: GradeInput, bundle: HoldoutBundle) => Promise<GradeResult>;
  buildId: string;
}

interface ResolvedEntry {
  base_sha: string;
  assertion_set_digest: string;
  content_digest: string;
  lockEntry: HoldoutLockEntry | null;
  publicSource: PublicFixtureSource | null;
}

interface Bound {
  claim: ReceiptClaimBody;
  ref: FixtureRef;
  entry: ResolvedEntry;
  finalSha: string;
}

type Guard = { ok: true; bound: Bound } | { ok: false; result: VerifyResult };
type Loaded = { ok: true; bundle: HoldoutBundle } | { ok: false; result: VerifyResult };

function reject(reason: VerifyRejectReason, detail?: string): VerifyResult {
  return detail === undefined
    ? { status: "rejected", reason }
    : { status: "rejected", reason, detail };
}

function parseClaimAndEpisode(
  claim: unknown,
  episode: unknown,
): { claim: ReceiptClaimBody; episode: Episode } | null {
  const parsedClaim = ReceiptClaimSchema.safeParse(claim);
  const parsedEpisode = EpisodeSchema.safeParse(episode);
  if (!parsedClaim.success || !parsedEpisode.success) {
    return null;
  }
  return { claim: parsedClaim.data, episode: parsedEpisode.data };
}

function resolveEntry(
  ref: FixtureRef,
  split: Episode["split"],
  ctx: VerifyContext,
): ResolvedEntry | null {
  if (split === "holdout") {
    const lockEntry = ctx.lock.entries.find(
      (entry) => entry.family_id === ref.family_id && entry.variant_id === ref.variant_id,
    );
    if (lockEntry === undefined) {
      return null;
    }
    return {
      base_sha: lockEntry.base_sha,
      assertion_set_digest: lockEntry.assertion_set_digest,
      content_digest: lockEntry.content_digest,
      lockEntry,
      publicSource: null,
    };
  }
  const publicSource = ctx.publicFixtures.find(
    (source) =>
      source.fixture.family_id === ref.family_id &&
      source.fixture.variant_id === ref.variant_id &&
      source.fixture.split === split,
  );
  if (publicSource === undefined) {
    return null;
  }
  return {
    base_sha: publicSource.fixture.base_sha,
    assertion_set_digest: publicSource.fixture.hidden_ref.assertion_set_digest,
    content_digest: publicSource.fixture.content_digest,
    lockEntry: null,
    publicSource,
  };
}

function checkBuild(claim: ReceiptClaimBody, ctx: VerifyContext): VerifyResult | null {
  const allowlisted = ctx.allowlist.builds.some((build) => build.id === claim.grader_build);
  if (!allowlisted) {
    return reject("grader_build_not_allowlisted");
  }
  if (claim.grader_build !== ctx.buildId) {
    return reject("grader_build_mismatch");
  }
  return null;
}

function checkDigest(claim: ReceiptClaimBody): VerifyResult | null {
  if (claim.receipt_digest === null) {
    return reject("receipt_digest_mismatch");
  }
  if (receiptDigest({ ...claim, receipt_digest: null }) !== claim.receipt_digest) {
    return reject("receipt_digest_mismatch");
  }
  return null;
}

function bindAndGuard(claim: unknown, episode: unknown, ctx: VerifyContext): Guard {
  const parsed = parseClaimAndEpisode(claim, episode);
  if (parsed === null) {
    return { ok: false, result: reject("malformed") };
  }
  const { claim: c, episode: e } = parsed;
  if (c.kind !== "hidden_assertion") {
    return { ok: false, result: reject("not_independent_kind") };
  }
  if (e.fixture_ref === null) {
    return { ok: false, result: reject("no_fixture_ref") };
  }
  const entry = resolveEntry(e.fixture_ref, e.split, ctx);
  if (entry === null) {
    return { ok: false, result: reject("fixture_unknown") };
  }
  if (e.repo.base_sha !== entry.base_sha) {
    return { ok: false, result: reject("base_mismatch") };
  }
  if (c.assertion_set_digest !== entry.assertion_set_digest) {
    return { ok: false, result: reject("fixture_mismatch") };
  }
  if (c.sha === null || c.sha !== e.final_sha) {
    return { ok: false, result: reject("sha_mismatch") };
  }
  const build = checkBuild(c, ctx);
  if (build !== null) {
    return { ok: false, result: build };
  }
  const digest = checkDigest(c);
  if (digest !== null) {
    return { ok: false, result: digest };
  }
  return { ok: true, bound: { claim: c, ref: e.fixture_ref, entry, finalSha: c.sha } };
}

async function loadBundle(entry: ResolvedEntry, ctx: VerifyContext): Promise<Loaded> {
  if (entry.lockEntry !== null) {
    try {
      return { ok: true, bundle: await ctx.store.readEntry(entry.lockEntry) };
    } catch (err) {
      if (err instanceof HoldoutStoreError) {
        return { ok: false, result: reject(err.code) };
      }
      throw err;
    }
  }
  const bundle = entry.publicSource?.bundle ?? null;
  if (bundle === null) {
    return { ok: false, result: reject("bundle_missing") };
  }
  if (bundleContentDigest(bundle) !== entry.content_digest) {
    return { ok: false, result: reject("content_digest_mismatch") };
  }
  return { ok: true, bundle };
}

async function checkBaseBuild(
  entry: ResolvedEntry,
  bundle: HoldoutBundle,
  ctx: VerifyContext,
): Promise<VerifyResult | null> {
  if (entry.lockEntry === null) {
    return null;
  }
  const rebuilt = await ctx.scratch.buildBase(bundle.repo_files);
  if (rebuilt !== entry.base_sha) {
    return reject("regrade_mismatch", "base_build");
  }
  return null;
}

async function regradeAndCompare(
  bound: Bound,
  bundle: HoldoutBundle,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  const regrade = await ctx.grade(
    { fixture_ref: bound.ref, base_sha: bound.entry.base_sha, final_sha: bound.finalSha },
    bundle,
  );
  if ("ungradeable" in regrade) {
    return reject("regrade_mismatch", `ungradeable:${regrade.ungradeable}`);
  }
  const claim = bound.claim;
  if (
    claim.claimed_verdict !== "unknown" &&
    regrade.claimed_verdict === claim.claimed_verdict &&
    regrade.fail_reason === claim.fail_reason &&
    canonicalJson(regrade.per_check) === canonicalJson(claim.per_check)
  ) {
    return {
      status: "verified",
      verdict: claim.claimed_verdict,
      fail_reason: claim.fail_reason,
      sha: bound.finalSha,
      control_verdict: "pass",
    };
  }
  return {
    status: "verified",
    verdict: "fail",
    fail_reason: "nondeterministic",
    sha: bound.finalSha,
    control_verdict: "pass",
  };
}

export async function verifyReceipt(
  claim: unknown,
  episode: unknown,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  const guard = bindAndGuard(claim, episode, ctx);
  if (!guard.ok) {
    return guard.result;
  }
  const { bound } = guard;
  const loaded = await loadBundle(bound.entry, ctx);
  if (!loaded.ok) {
    return loaded.result;
  }
  const baseBuild = await checkBaseBuild(bound.entry, loaded.bundle, ctx);
  if (baseBuild !== null) {
    return baseBuild;
  }
  const control = await ctx.controls.ensure(bound.ref, loaded.bundle);
  if (!control.ok) {
    return reject("regrade_mismatch", "control");
  }
  return await regradeAndCompare(bound, loaded.bundle, ctx);
}

export function receiptVerifier(ctx: VerifyContext): {
  verify(claim: unknown, episode: unknown): Promise<VerifyResult>;
} {
  return {
    verify: (claim: unknown, episode: unknown): Promise<VerifyResult> =>
      verifyReceipt(claim, episode, ctx),
  };
}
