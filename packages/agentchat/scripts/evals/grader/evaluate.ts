import type { HiddenAssertion, HoldoutBundle } from "@penumbra/core/evals/fixture";

import { canonicalJson, CanonicalJsonError } from "@penumbra/core/evals/canonical";

import type { GraderScratch } from "./scratch.js";

import { type DependencyProvider, linkDeps, readBaseDepsInput } from "./deps.js";
import { materialize } from "./materialize.js";
import {
  type LegCallResult,
  type LegResult,
  runProbeLeg,
  type SandboxKind,
  type SpawnFn,
} from "./sandbox.js";

export type Comparator = (a: unknown, b: unknown) => boolean;

export const defaultCompare: Comparator = (a, b) => {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch (err) {
    if (err instanceof CanonicalJsonError) {
      return false;
    }
    throw err;
  }
};

export function seededShuffle<T>(xs: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = xs.slice();
  let i = out.length - 1;
  while (i > 0) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
    i -= 1;
  }
  return out;
}

export interface PerCheck {
  id: string;
  ok: boolean;
}

export type EvalUnavailableReason = "final_missing" | "materialize_error" | "deps_unavailable";

export type EvalOutcome =
  | { kind: "evaluated"; per_check: PerCheck[]; all_ok: boolean }
  | { kind: "timeout" }
  | { kind: "contract_violation" }
  | { kind: "unavailable"; reason: EvalUnavailableReason };

export interface EvaluateOptions {
  bundle: HoldoutBundle;
  scratch: GraderScratch;
  sha: string;
  baseSha: string;
  sandbox: SandboxKind;
  deps: DependencyProvider;
  spawn?: SpawnFn | undefined;
  timeoutMs: number;
  treeId: string;
  compare?: Comparator | undefined;
}

type ProbeAssertion = Extract<HiddenAssertion, { kind: "probe" }>;
type FileAssertion = Extract<HiddenAssertion, { kind: "file_matches" | "file_absent" }>;
type InvariantAssertion = Extract<HiddenAssertion, { kind: "invariant" }>;

interface EvalEnv {
  scratch: GraderScratch;
  shaForGit: string;
  sandbox: SandboxKind;
  spawn: SpawnFn | undefined;
  timeoutMs: number;
  treeId: string;
  treeDir: string;
  depsDir: string;
  compare: Comparator;
  checks: Map<string, boolean>;
  legSeq: number;
}

type CallOutcome =
  | { kind: "leg"; out: LegCallResult | null }
  | { kind: "timeout" }
  | { kind: "contract_violation" };

async function runLeg(
  env: EvalEnv,
  moduleRel: string,
  calls: { id: string; export: string; input: unknown }[],
): Promise<LegResult> {
  const tmpRoot = env.scratch.newLegTmp(`${env.treeId}-leg-${String(env.legSeq)}`);
  env.legSeq += 1;
  return await runProbeLeg({
    sandbox: env.sandbox,
    leg: { module_rel: moduleRel, calls },
    timeoutMs: env.timeoutMs,
    dirs: { treeDir: env.treeDir, depsDir: env.depsDir },
    spawn: env.spawn,
    tmpRoot,
  });
}

// One fresh process per call: invariant legs can never share a process or a
// memoized value, which is what makes deterministic/idempotent meaningful.
async function callOnce(
  env: EvalEnv,
  a: { id: string; module: string; export: string },
  input: unknown,
): Promise<CallOutcome> {
  const res = await runLeg(env, a.module, [{ id: a.id, export: a.export, input }]);
  if (res.kind === "tamper") {
    return { kind: "contract_violation" };
  }
  if (res.kind === "timeout") {
    return { kind: "timeout" };
  }
  if (res.kind !== "ok") {
    return { kind: "leg", out: null };
  }
  return { kind: "leg", out: res.results.find((r) => r.id === a.id) ?? null };
}

function hasOutput(result: LegCallResult | null): result is { id: string; output: unknown } {
  return result !== null && "output" in result;
}

async function evalFileAssertion(
  scratch: GraderScratch,
  sha: string,
  a: FileAssertion,
): Promise<boolean> {
  const res = await scratch.git(["cat-file", "blob", `${sha}:${a.path}`]);
  if (a.kind === "file_absent") {
    return res.code !== 0;
  }
  return res.code === 0 && new RegExp(a.pattern).test(res.stdout.toString("utf8"));
}

// All probe calls against one module share a single leg (one process); the
// grader still reports per-assertion checks under each assertion's own id.
async function evalProbeModule(
  env: EvalEnv,
  moduleRel: string,
  group: ProbeAssertion[],
): Promise<EvalOutcome | null> {
  const calls = group.map((a) => ({ id: a.id, export: a.export, input: a.input }));
  const res = await runLeg(env, moduleRel, calls);
  if (res.kind === "tamper") {
    return { kind: "contract_violation" };
  }
  if (res.kind === "timeout") {
    return { kind: "timeout" };
  }
  const results = res.kind === "ok" ? res.results : [];
  for (const a of group) {
    const entry = results.find((r) => r.id === a.id);
    env.checks.set(
      a.id,
      entry !== undefined && "output" in entry && env.compare(entry.output, a.expect),
    );
  }
  return null;
}

async function evalPair(
  env: EvalEnv,
  a: InvariantAssertion,
  firstInput: unknown,
  secondInput: unknown,
): Promise<boolean | "timeout" | "contract_violation"> {
  const first = await callOnce(env, a, firstInput);
  if (first.kind !== "leg") {
    return first.kind;
  }
  const second = await callOnce(env, a, secondInput);
  if (second.kind !== "leg") {
    return second.kind;
  }
  return (
    hasOutput(first.out) &&
    hasOutput(second.out) &&
    env.compare(first.out.output, second.out.output)
  );
}

async function evalInvariantInput(
  env: EvalEnv,
  a: InvariantAssertion,
  x: unknown,
): Promise<boolean | "timeout" | "contract_violation"> {
  if (a.property === "idempotent") {
    const first = await callOnce(env, a, x);
    if (first.kind !== "leg") {
      return first.kind;
    }
    if (!hasOutput(first.out)) {
      return false;
    }
    const second = await callOnce(env, a, first.out.output);
    if (second.kind !== "leg") {
      return second.kind;
    }
    return hasOutput(second.out) && env.compare(second.out.output, first.out.output);
  }
  if (a.property === "order_insensitive") {
    // The shuffle is computed here in the parent, never in the probe process:
    // the candidate sees only two raw inputs and cannot detect the pairing.
    if (!Array.isArray(x)) {
      return false;
    }
    return await evalPair(env, a, x, seededShuffle(x as unknown[], a.seed));
  }
  return await evalPair(env, a, x, x);
}

async function evalInvariant(env: EvalEnv, a: InvariantAssertion): Promise<EvalOutcome | null> {
  let ok = true;
  for (const x of a.inputs) {
    const res = await evalInvariantInput(env, a, x);
    if (res === "timeout") {
      return { kind: "timeout" };
    }
    if (res === "contract_violation") {
      return { kind: "contract_violation" };
    }
    ok &&= res;
  }
  env.checks.set(a.id, ok);
  return null;
}

function groupProbes(bundle: HoldoutBundle): Map<string, ProbeAssertion[]> {
  const groups = new Map<string, ProbeAssertion[]>();
  for (const a of bundle.assertions) {
    if (a.kind !== "probe") {
      continue;
    }
    const group = groups.get(a.module) ?? [];
    group.push(a);
    groups.set(a.module, group);
  }
  return groups;
}

async function evalChecks(env: EvalEnv, bundle: HoldoutBundle): Promise<EvalOutcome | null> {
  for (const a of bundle.assertions) {
    if (a.kind === "file_matches" || a.kind === "file_absent") {
      env.checks.set(a.id, await evalFileAssertion(env.scratch, env.shaForGit, a));
    }
  }
  for (const [moduleRel, group] of groupProbes(bundle)) {
    const abort = await evalProbeModule(env, moduleRel, group);
    if (abort !== null) {
      return abort;
    }
  }
  for (const a of bundle.assertions) {
    if (a.kind !== "invariant") {
      continue;
    }
    const abort = await evalInvariant(env, a);
    if (abort !== null) {
      return abort;
    }
  }
  return null;
}

export async function evaluateCommit(opts: EvaluateOptions): Promise<EvalOutcome> {
  const mat = await materialize({
    repo: opts.scratch.repoDir,
    sha: opts.sha,
    outDir: opts.scratch.newTree(opts.treeId),
    gitEnv: opts.scratch.gitEnv,
  });
  if (!mat.ok) {
    if (mat.model_failure !== undefined) {
      return { kind: "contract_violation" };
    }
    if (mat.unknown?.reason === "base_missing") {
      return { kind: "unavailable", reason: "final_missing" };
    }
    return { kind: "unavailable", reason: "materialize_error" };
  }
  const depsInput = await readBaseDepsInput({
    repo: opts.scratch.repoDir,
    baseSha: opts.baseSha,
    gitEnv: opts.scratch.gitEnv,
  });
  const ensured = await opts.deps.ensure(depsInput);
  if (!ensured.ok) {
    return { kind: "unavailable", reason: "deps_unavailable" };
  }
  await linkDeps({ treeDir: mat.treeDir, cacheDir: ensured.cacheDir, workspaces: [] });

  const env: EvalEnv = {
    scratch: opts.scratch,
    shaForGit: opts.sha,
    sandbox: opts.sandbox,
    spawn: opts.spawn,
    timeoutMs: opts.timeoutMs,
    treeId: opts.treeId,
    treeDir: mat.treeDir,
    depsDir: ensured.cacheDir,
    compare: opts.compare ?? defaultCompare,
    checks: new Map(),
    legSeq: 0,
  };
  const abort = await evalChecks(env, opts.bundle);
  if (abort !== null) {
    return abort;
  }
  const perCheck = opts.bundle.assertions.map((a) => ({
    id: a.id,
    ok: env.checks.get(a.id) ?? false,
  }));
  return { kind: "evaluated", per_check: perCheck, all_ok: perCheck.every((c) => c.ok) };
}
