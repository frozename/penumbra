import type { HoldoutBundle } from "@penumbra/core/evals/fixture";

import type { DependencyProvider } from "./deps.js";
import type { SandboxKind, SpawnFn } from "./sandbox.js";
import type { GraderScratch } from "./scratch.js";

import { type Comparator, evaluateCommit, type PerCheck } from "./evaluate.js";

export interface FixtureRef {
  family_id: string;
  variant_id: string;
}

export function controlKey(ref: FixtureRef, buildId: string): string {
  return `${ref.family_id}/${ref.variant_id}@${buildId}`;
}

export interface ControlResult {
  verdict: "pass" | "fail" | "timeout";
  per_check: PerCheck[];
}

export type SelfQualifyResult = { ok: true } | { ok: false; reason: "grader_permissive" };

export interface ControlOutcome {
  key: string;
  control: ControlResult;
  self_qualification: SelfQualifyResult | null;
  ok: boolean;
}

export interface QualifyControlOptions {
  bundle: HoldoutBundle;
  scratch: GraderScratch;
  baseSha: string;
  sandbox: SandboxKind;
  deps: DependencyProvider;
  buildId: string;
  spawn?: SpawnFn | undefined;
  timeoutMs: number;
  compare?: Comparator | undefined;
}

export interface SelfQualifyOptions extends QualifyControlOptions {
  control: ControlResult;
}

export interface ControlCacheEnv {
  scratch: GraderScratch;
  sandbox: SandboxKind;
  deps: DependencyProvider;
  buildId: string;
  spawn?: SpawnFn | undefined;
  timeoutMs: number;
  compare?: Comparator | undefined;
}

export async function qualifyControl(
  _ref: FixtureRef,
  opts: QualifyControlOptions,
): Promise<ControlResult> {
  const goodSha = await opts.scratch.applyPatch(opts.baseSha, opts.bundle.patches.good);
  const outcome = await evaluateCommit({
    bundle: opts.bundle,
    scratch: opts.scratch,
    sha: goodSha,
    baseSha: opts.baseSha,
    sandbox: opts.sandbox,
    deps: opts.deps,
    spawn: opts.spawn,
    timeoutMs: opts.timeoutMs,
    treeId: "control",
    compare: opts.compare,
  });
  if (outcome.kind === "evaluated") {
    return { verdict: outcome.all_ok ? "pass" : "fail", per_check: outcome.per_check };
  }
  return { verdict: outcome.kind === "timeout" ? "timeout" : "fail", per_check: [] };
}

// A grader is only trustworthy if every known-bad and mutant patch fails it.
// Any non-pass outcome (fail, timeout, contract violation, unavailable) counts
// as killed; a single all_ok proves the grader cannot tell good from bad.
export async function selfQualify(
  _ref: FixtureRef,
  opts: SelfQualifyOptions,
): Promise<SelfQualifyResult> {
  if (opts.bundle.assertions.length === 0 || opts.control.verdict !== "pass") {
    return { ok: false, reason: "grader_permissive" };
  }
  const killers = [
    ...opts.bundle.patches.bad.map((patch, i) => ({ patch, treeId: `selfq-bad-${String(i)}` })),
    ...opts.bundle.mutants.map((patch, i) => ({ patch, treeId: `selfq-mut-${String(i)}` })),
  ];
  for (const killer of killers) {
    const sha = await opts.scratch.applyPatch(opts.baseSha, killer.patch);
    const outcome = await evaluateCommit({
      bundle: opts.bundle,
      scratch: opts.scratch,
      sha,
      baseSha: opts.baseSha,
      sandbox: opts.sandbox,
      deps: opts.deps,
      spawn: opts.spawn,
      timeoutMs: opts.timeoutMs,
      treeId: killer.treeId,
      compare: opts.compare,
    });
    if (outcome.kind === "evaluated" && outcome.all_ok) {
      return { ok: false, reason: "grader_permissive" };
    }
  }
  return { ok: true };
}

export class ControlCache {
  readonly buildId: string;
  private readonly env: ControlCacheEnv;
  private readonly outcomes = new Map<string, Promise<ControlOutcome>>();

  constructor(env: ControlCacheEnv) {
    this.env = env;
    this.buildId = env.buildId;
  }

  ensure(ref: FixtureRef, bundle: HoldoutBundle): Promise<ControlOutcome> {
    const key = controlKey(ref, this.buildId);
    const existing = this.outcomes.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const promise = this.compute(ref, bundle, key);
    this.outcomes.set(key, promise);
    return promise;
  }

  private async compute(
    ref: FixtureRef,
    bundle: HoldoutBundle,
    key: string,
  ): Promise<ControlOutcome> {
    const baseSha = await this.env.scratch.buildBase(bundle.repo_files);
    const shared: QualifyControlOptions = {
      bundle,
      scratch: this.env.scratch,
      baseSha,
      sandbox: this.env.sandbox,
      deps: this.env.deps,
      buildId: this.env.buildId,
      spawn: this.env.spawn,
      timeoutMs: this.env.timeoutMs,
      compare: this.env.compare,
    };
    const control = await qualifyControl(ref, shared);
    const selfQualification =
      control.verdict === "pass" ? await selfQualify(ref, { ...shared, control }) : null;
    return {
      key,
      control,
      self_qualification: selfQualification,
      ok: selfQualification?.ok === true,
    };
  }
}
