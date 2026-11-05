import { assertionSetDigest, type HoldoutBundle } from "@penumbra/core/evals/fixture";
import {
  type ReceiptClaimBody,
  ReceiptClaimSchema,
  receiptDigest,
} from "@penumbra/core/evals/manifest";
import { randomBytes } from "node:crypto";

import type { ControlOutcome, ControlResult, FixtureRef, SelfQualifyResult } from "./control.js";
import type { DependencyProvider } from "./deps.js";
import type { Comparator, EvalOutcome, PerCheck } from "./evaluate.js";
import type { SandboxKind, SpawnFn } from "./sandbox.js";
import type { GraderScratch } from "./scratch.js";

import {
  comparatorIdentity,
  ControlCache,
  controlKey,
  DEFAULT_COMPARATOR_ID,
  qualifyControl,
  selfQualify,
} from "./control.js";
import { evaluateCommit, seededShuffle } from "./evaluate.js";

// Runtime re-exports: graderBuildId hashes the transitive closure of this
// module, so the whole grader pipeline is covered by the build id.
export {
  comparatorIdentity,
  ControlCache,
  controlKey,
  DEFAULT_COMPARATOR_ID,
  qualifyControl,
  seededShuffle,
  selfQualify,
};
export type {
  Comparator,
  ControlOutcome,
  ControlResult,
  EvalOutcome,
  FixtureRef,
  PerCheck,
  SelfQualifyResult,
};

export interface GradeInput {
  fixture_ref: FixtureRef;
  base_sha: string;
  final_sha: string;
}

export interface GradeOptions {
  bundle: HoldoutBundle;
  scratch: GraderScratch;
  controls: ControlCache;
  deps: DependencyProvider;
  sandbox: SandboxKind;
  spawn?: SpawnFn | undefined;
  timeoutMs: number;
}

export type UngradeableReason =
  | "grader_control_failed"
  | "base_missing"
  | "final_missing"
  | "deps_unavailable"
  | "materialize_error";

export type GradeResult = ReceiptClaimBody | { ungradeable: UngradeableReason };

const FULL_SHA = /^[0-9a-f]{40}$/;

async function commitExists(scratch: GraderScratch, sha: string): Promise<boolean> {
  if (!FULL_SHA.test(sha)) {
    return false;
  }
  const res = await scratch.git(["cat-file", "-e", `${sha}^{commit}`]);
  return res.code === 0;
}

function signReceipt(
  opts: GradeOptions,
  sha: string,
  claimedVerdict: "pass" | "fail",
  failReason: ReceiptClaimBody["fail_reason"],
  perCheck: PerCheck[],
): ReceiptClaimBody {
  const body: ReceiptClaimBody = {
    kind: "hidden_assertion",
    sha,
    producer: "grader",
    claimed_verdict: claimedVerdict,
    fail_reason: failReason,
    assertion_set_digest: assertionSetDigest(opts.bundle),
    grader_build: opts.controls.buildId,
    per_check: perCheck,
    control_verdict: "pass",
    receipt_digest: null,
  };
  body.receipt_digest = receiptDigest(body);
  return ReceiptClaimSchema.parse(body);
}

export async function grade(input: GradeInput, opts: GradeOptions): Promise<GradeResult> {
  const control = await opts.controls.ensure(input.fixture_ref, opts.bundle);
  if (!control.ok) {
    return { ungradeable: "grader_control_failed" };
  }
  if (!(await commitExists(opts.scratch, input.base_sha))) {
    return { ungradeable: "base_missing" };
  }
  if (!(await commitExists(opts.scratch, input.final_sha))) {
    return { ungradeable: "final_missing" };
  }
  const ancestor = await opts.scratch.git([
    "merge-base",
    "--is-ancestor",
    input.base_sha,
    input.final_sha,
  ]);
  if (ancestor.code === 1) {
    return signReceipt(opts, input.final_sha, "fail", "base_not_ancestor", []);
  }
  if (ancestor.code !== 0) {
    return { ungradeable: "final_missing" };
  }
  const outcome = await evaluateCommit({
    bundle: opts.bundle,
    scratch: opts.scratch,
    sha: input.final_sha,
    baseSha: input.base_sha,
    sandbox: opts.sandbox,
    deps: opts.deps,
    spawn: opts.spawn,
    timeoutMs: opts.timeoutMs,
    treeId: `cand-${randomBytes(6).toString("hex")}`,
    compare: opts.controls.compare,
  });
  switch (outcome.kind) {
    case "contract_violation":
      return signReceipt(opts, input.final_sha, "fail", "contract_violation", []);
    case "timeout":
      return signReceipt(opts, input.final_sha, "fail", "candidate_timeout", []);
    case "unavailable":
      return { ungradeable: outcome.reason };
    case "evaluated":
      return outcome.all_ok
        ? signReceipt(opts, input.final_sha, "pass", null, outcome.per_check)
        : signReceipt(opts, input.final_sha, "fail", "hidden_failed", outcome.per_check);
  }
}
