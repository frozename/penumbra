import type { GroupReport, ReceiptVerifier } from "@penumbra/core/evals/aggregate";
import type { UnsealToken } from "@penumbra/core/evals/compare";
import type { HoldoutBundle, HoldoutLock } from "@penumbra/core/evals/fixture";
import type { Episode } from "@penumbra/core/evals/manifest";

import { sha256Hex } from "@penumbra/core/evals/canonical";
import { computeLockDigest, unsealHoldout, verifyHoldoutLock } from "@penumbra/core/evals/holdout";
import { EpisodeSchema } from "@penumbra/core/evals/manifest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { SandboxKind } from "./grader/sandbox.js";
import type { GraderScratch } from "./grader/scratch.js";
import type { ReportIngest } from "./report.js";
import type { RunDeps } from "./run.js";

import { type CorpusFixture, DEFAULT_CORPUS_ROOT, lintCorpus } from "./corpus.js";
import { ControlCache } from "./grader/control.js";
import { type DependencyProvider } from "./grader/deps.js";
import { grade, type GradeInput, type GradeResult } from "./grader/grade.js";
import { type HoldoutStore, HoldoutStoreError, openHoldoutStore } from "./grader/holdout-store.js";
import {
  type GraderAllowlist,
  type VerifyContext,
  verifyReceipt,
  type VerifyResult,
} from "./grader/verify.js";

export const STAGE_NAMES = [
  "validate",
  "ingest",
  "replay",
  "grade",
  "verify",
  "aggregate",
  "compare",
  "plan",
  "report",
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export interface StageInvocation {
  name: StageName;
  flags: [string, string][];
}

export interface StageOutcome {
  code: 0 | 1 | 2;
  output: string;
  stderr: string;
}

export class StageError extends Error {
  readonly code: 1 | 2;

  constructor(code: 1 | 2, message: string) {
    super(message);
    this.name = "StageError";
    this.code = code;
  }
}

export function okOutcome(output: string): StageOutcome {
  return { code: 0, output, stderr: "" };
}

export function failOutcome(code: 1 | 2, stderr: string): StageOutcome {
  return { code, output: "", stderr };
}

export function stageFlag(stage: StageInvocation, name: string): string | undefined {
  for (const [flag, value] of stage.flags) {
    if (flag === name) {
      return value;
    }
  }
  return undefined;
}

export function intFlag(stage: StageInvocation, name: string): number | undefined {
  const raw = stageFlag(stage, name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function flagAcross(stages: readonly StageInvocation[], name: string): string[] {
  const out: string[] = [];
  for (const stage of stages) {
    for (const [flag, value] of stage.flags) {
      if (flag === name) {
        out.push(value);
      }
    }
  }
  return out;
}

export function firstFlagAcross(
  stages: readonly StageInvocation[],
  name: string,
): string | undefined {
  return flagAcross(stages, name)[0];
}

export interface GradingEnv {
  buildId: string;
  allowlist: GraderAllowlist;
  depProvider: DependencyProvider;
  sandboxKind: SandboxKind;
  controls: ControlCache;
}

export interface SessionState {
  deps: RunDeps;
  scratch: GraderScratch;
  episodes: Episode[] | null;
  ingest: ReportIngest | null;
  corpusFixtures: CorpusFixture[] | null;
  corpusRoot: string;
  lock: HoldoutLock | null;
  grant: UnsealToken | null;
  unsealPlan: UnsealPlan | null;
  store: HoldoutStore | null;
  seed: number;
  groups: GroupReport[];
  verifyCache: Map<string, VerifyResult>;
  gradeOutcomes: Map<string, string>;
  grading: GradingEnv | null;
  verifyCtx: Promise<VerifyContext> | null;
}

export function makeSession(
  deps: RunDeps,
  scratch: GraderScratch,
  stages: readonly StageInvocation[],
): SessionState {
  const seedRaw = firstFlagAcross(stages, "--seed");
  const parsedSeed = seedRaw === undefined ? Number.NaN : Number.parseInt(seedRaw, 10);
  return {
    deps,
    scratch,
    episodes: null,
    ingest: null,
    corpusFixtures: null,
    corpusRoot: firstFlagAcross(stages, "--corpus") ?? DEFAULT_CORPUS_ROOT,
    lock: null,
    grant: null,
    unsealPlan: null,
    store: null,
    seed: Number.isNaN(parsedSeed) ? 0 : parsedSeed,
    groups: [],
    verifyCache: new Map<string, VerifyResult>(),
    gradeOutcomes: new Map<string, string>(),
    grading: null,
    verifyCtx: null,
  };
}

export async function ensureGrading(session: SessionState): Promise<GradingEnv> {
  if (session.grading !== null) {
    return session.grading;
  }
  const buildId = await session.deps.buildId();
  const sandboxKind = await session.deps.sandbox();
  const depProvider = session.deps.deps();
  const env: GradingEnv = {
    buildId,
    allowlist: session.deps.allowlist(),
    depProvider,
    sandboxKind,
    controls: new ControlCache({
      scratch: session.scratch,
      sandbox: sandboxKind,
      deps: depProvider,
      buildId,
      timeoutMs: session.deps.timeoutMs,
    }),
  };
  session.grading = env;
  return env;
}

export async function ensureCorpus(session: SessionState): Promise<CorpusFixture[]> {
  if (session.corpusFixtures !== null) {
    return session.corpusFixtures;
  }
  const fixtures = await lintCorpus(session.corpusRoot, {
    scratch: session.scratch,
    lock: session.lock ?? undefined,
  });
  session.corpusFixtures = fixtures;
  return fixtures;
}

export function ensureEpisodes(session: SessionState, stage: StageInvocation): Episode[] {
  if (session.episodes !== null) {
    return session.episodes;
  }
  const path = stageFlag(stage, "--episodes");
  if (path === undefined) {
    throw new StageError(2, "usage: stage requires --episodes <jsonl> or a prior stage\n");
  }
  let text: string;
  try {
    text = readFileSync(resolve(path), "utf8");
  } catch {
    throw new StageError(2, `episodes_unreadable ${path}\n`);
  }
  const episodes: Episode[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const parsed = EpisodeSchema.safeParse(JSON.parse(line) as unknown);
    if (!parsed.success) {
      throw new StageError(1, `episodes_invalid ${parsed.error.issues[0]?.message ?? "schema"}\n`);
    }
    episodes.push(parsed.data);
  }
  session.episodes = episodes;
  return episodes;
}

// --- holdout store / lock / unseal ---------------------------------------------

function readLockFile(path: string): HoldoutLock {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  } catch (err) {
    throw new StageError(2, `lock_invalid unreadable ${path}: ${String(err)}\n`);
  }
  try {
    return verifyHoldoutLock(raw);
  } catch (err) {
    throw new StageError(2, `lock_invalid ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

interface UnsealPlan {
  planPath: string;
  repoRoot: string;
  grant: UnsealToken;
}

function readUnsealPlan(lock: HoldoutLock, unsealFlag: string): UnsealPlan {
  const planPath = resolve(unsealFlag);
  let bytes: Buffer;
  let raw: unknown;
  try {
    bytes = readFileSync(planPath);
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (err) {
    throw new StageError(2, `unseal_invalid unreadable ${unsealFlag}: ${String(err)}\n`);
  }
  const maxUnseals =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)["max_unseals"]
      : undefined;
  if (typeof maxUnseals !== "number" || !Number.isInteger(maxUnseals) || maxUnseals < 1) {
    throw new StageError(2, "unseal_invalid plan max_unseals must be an integer >= 1\n");
  }
  try {
    const grant = unsealHoldout(lock, { sha256: sha256Hex(bytes), max_unseals: maxUnseals });
    return { planPath, repoRoot: dirname(planPath), grant };
  } catch (err) {
    throw new StageError(2, `unseal_invalid ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function storeFlagConflict(stages: readonly StageInvocation[]): string | null {
  for (const name of ["--holdout-store", "--lock", "--unseal"]) {
    if (new Set(flagAcross(stages, name)).size > 1) {
      return `store_flags_conflict ${name} given conflicting values\n`;
    }
  }
  return null;
}

function resolveLockAndGrant(
  session: SessionState,
  stages: readonly StageInvocation[],
): StageOutcome | null {
  const lockPath = firstFlagAcross(stages, "--lock");
  if (lockPath !== undefined) {
    session.lock = readLockFile(lockPath);
  }
  const unsealPath = firstFlagAcross(stages, "--unseal");
  if (unsealPath === undefined) {
    return null;
  }
  if (session.lock === null) {
    return failOutcome(2, "unseal_invalid --unseal requires --lock\n");
  }
  const plan = readUnsealPlan(session.lock, unsealPath);
  session.unsealPlan = plan;
  session.grant = plan.grant;
  return null;
}

function openStoreOnce(session: SessionState, storePath: string): Promise<StageOutcome | null> {
  const lock = session.lock;
  if (lock === null) {
    return Promise.resolve(failOutcome(2, "usage: --holdout-store requires --lock\n"));
  }
  const plan = session.unsealPlan;
  if (plan === null && lock.entries.some((entry) => !entry.synthetic)) {
    return Promise.resolve(
      failOutcome(
        2,
        "unseal_required holdout lock contains non-synthetic entries; pass --unseal <plan.json>\n",
      ),
    );
  }
  const open =
    plan === null
      ? openHoldoutStore({ storePath, lock })
      : openHoldoutStore({
          storePath,
          lock,
          unseal: plan.grant,
          planPath: plan.planPath,
          repoRoot: plan.repoRoot,
        });
  return open
    .then((store) => {
      session.store = store;
      return null;
    })
    .catch((err: unknown) => {
      if (err instanceof HoldoutStoreError) {
        return failOutcome(2, `${err.code} ${err.message}\n`);
      }
      if (err instanceof Error && err.name === "UnsealExhausted") {
        return failOutcome(2, `unseal_exhausted ${err.message}\n`);
      }
      throw err;
    });
}

export async function resolveSessionStore(
  session: SessionState,
  stages: readonly StageInvocation[],
): Promise<StageOutcome | null> {
  const conflict = storeFlagConflict(stages);
  if (conflict !== null) {
    return failOutcome(2, conflict);
  }
  const lockOutcome = resolveLockAndGrant(session, stages);
  if (lockOutcome !== null) {
    return lockOutcome;
  }
  const storePath = firstFlagAcross(stages, "--holdout-store");
  if (storePath === undefined) {
    return null;
  }
  return await openStoreOnce(session, storePath);
}

// --- verify plumbing ------------------------------------------------------------

function emptyLock(): HoldoutLock {
  return { schema_version: 1, entries: [], digest: computeLockDigest([]) };
}

function throwingStore(): Pick<HoldoutStore, "readEntry"> {
  return {
    readEntry: () =>
      Promise.reject(new HoldoutStoreError("unseal_required", "no holdout store in session")),
  };
}

function gradeFn(session: SessionState, env: GradingEnv) {
  return (input: GradeInput, bundle: HoldoutBundle): Promise<GradeResult> =>
    grade(input, {
      bundle,
      scratch: session.scratch,
      controls: env.controls,
      deps: env.depProvider,
      sandbox: env.sandboxKind,
      timeoutMs: session.deps.timeoutMs,
    });
}

export async function buildVerifyContext(session: SessionState): Promise<VerifyContext> {
  const env = await ensureGrading(session);
  const fixtures = await ensureCorpus(session);
  return {
    lock: session.lock ?? emptyLock(),
    publicFixtures: fixtures.map((entry) => ({ fixture: entry.fixture, bundle: entry.bundle })),
    store: session.store ?? throwingStore(),
    scratch: session.scratch,
    controls: env.controls,
    allowlist: env.allowlist,
    grade: gradeFn(session, env),
    buildId: env.buildId,
  };
}

export function verifyKey(episodeId: string, receiptDigest: string | null): string {
  return `${episodeId}:${receiptDigest ?? "null"}`;
}

export function sessionVerifier(session: SessionState): ReceiptVerifier {
  return {
    verify: async (claim, episode): Promise<VerifyResult> => {
      const key = verifyKey(episode.episode_id, claim.receipt_digest);
      const cached = session.verifyCache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      session.verifyCtx ??= buildVerifyContext(session);
      const ctx = await session.verifyCtx;
      const result = await verifyReceipt(claim, episode, ctx);
      session.verifyCache.set(key, result);
      return result;
    },
  };
}

export function resolveFixtureFor(session: SessionState, ref: Episode["fixture_ref"]): unknown {
  if (ref === null) {
    return null;
  }
  const corpus = session.corpusFixtures?.find(
    (entry) =>
      entry.fixture.family_id === ref.family_id && entry.fixture.variant_id === ref.variant_id,
  );
  if (corpus !== undefined) {
    return corpus.fixture;
  }
  return (
    session.lock?.entries.find(
      (entry) => entry.family_id === ref.family_id && entry.variant_id === ref.variant_id,
    ) ?? null
  );
}
