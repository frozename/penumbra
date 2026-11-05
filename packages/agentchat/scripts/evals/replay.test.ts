import type { HoldoutBundle, HoldoutLock, HoldoutLockEntry } from "@penumbra/core/evals/fixture";

import { computeLockDigest } from "@penumbra/core/evals/holdout";
import { parseRetryOf } from "@penumbra/core/evals/lineage";
import { type Episode, EpisodeSchema } from "@penumbra/core/evals/manifest";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSilentRetryPayload } from "@src/worker/silent-failure-retry.js";

import type { DependencyProvider } from "./grader/deps.js";

import { type CorpusFixture, DEFAULT_CORPUS_ROOT, lintCorpus } from "./corpus.js";
import { ControlCache, grade, type GradeInput, type GradeResult } from "./grader/grade.js";
import { type GraderScratch, openGraderScratch } from "./grader/scratch.js";
import { type VerifyContext, verifyReceipt } from "./grader/verify.js";

// replay.ts does not exist yet: the P12 fixture-replay surface is declared
// structurally below and the module is loaded dynamically so the replay
// cases fail on the `expect(replayMod).not.toBeNull()` assertion at RED
// time instead of on a missing import (the same pattern verify.test.ts uses).
interface ReplayOptions {
  scratch: GraderScratch;
  store?: {
    sessionId: string | null;
    readEntry(entry: HoldoutLockEntry): Promise<HoldoutBundle>;
  };
  lock?: HoldoutLock;
}

interface ReplayModule {
  buildReplayEpisodes(fixtures: readonly CorpusFixture[], opts: ReplayOptions): Promise<unknown[]>;
}

const REPLAY_URL = new URL("./replay.ts", import.meta.url).href;

let replayMod: ReplayModule | null = null;

beforeAll(async () => {
  replayMod = (await import(REPLAY_URL).catch(() => null)) as ReplayModule | null;
});

function replay(): ReplayModule {
  expect(replayMod).not.toBeNull();
  return replayMod!;
}

const scratches: GraderScratch[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    scratch.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function mkScratch(): Promise<GraderScratch> {
  const scratch = await openGraderScratch({ sourceRepo: null });
  scratches.push(scratch);
  return scratch;
}

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadEntry(scratch: GraderScratch): Promise<CorpusFixture> {
  const fixtures = await lintCorpus(DEFAULT_CORPUS_ROOT, { scratch });
  const entry = fixtures.find((fixture) => fixture.dir === "synthetic/syn-contract-validator");
  if (entry === undefined) {
    throw new Error("synthetic/syn-contract-validator missing from lintCorpus output");
  }
  return entry;
}

function requireParts(entry: CorpusFixture): {
  repoFiles: Record<string, string>;
  bundle: HoldoutBundle;
} {
  if (entry.repoFiles === null || entry.bundle === null) {
    throw new Error(`${entry.dir} must carry repo files and a bundle`);
  }
  return { repoFiles: entry.repoFiles, bundle: entry.bundle };
}

function toEpisodes(eps: unknown[]): Episode[] {
  return eps.map((ep) => EpisodeSchema.parse(ep));
}

function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const ent of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) {
        walk(child);
      } else {
        out[child] = readFileSync(join(dir, child), "utf8");
      }
    }
  };
  walk("");
  return out;
}

// bun:test's `.rejects.toThrow(...)` is typed as returning void, so the
// rejection assertions below are hand-rolled (same pattern as verify.test.ts).
async function catchErr(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function gradeInputFor(ep: Episode): GradeInput {
  return {
    fixture_ref: ep.fixture_ref!,
    base_sha: ep.repo.base_sha!,
    final_sha: ep.final_sha!,
  };
}

test("silent-retry writer stamp parses back through core parseRetryOf", () => {
  const payload = buildSilentRetryPayload({
    failed_handoff_id: "h-x",
    failed_to_agent: "a",
    conversation_id: "conv-1",
    project_id: "penumbra",
    task_type: "implement_small",
    branch_name: null,
    message: "m",
    next_agent: "n",
  });
  expect(parseRetryOf(payload.message)).toBe("h-x");
});

test("buildReplayEpisodes replays syn-contract-validator into 2 controlled episodes", async () => {
  const scratch = await mkScratch();
  const entry = await loadEntry(scratch);
  const corpusDir = join(DEFAULT_CORPUS_ROOT, entry.dir);
  const snapshotBefore = snapshotTree(corpusDir);

  const eps = await replay().buildReplayEpisodes([entry], { scratch });
  expect(eps).toHaveLength(2);
  for (const ep of eps) {
    expect(EpisodeSchema.safeParse(ep).success).toBe(true);
  }
  const episodes = toEpisodes(eps);
  const goodEp = episodes[0]!;
  const badEp = episodes[1]!;

  const finalShas = episodes.map((ep) => ep.final_sha);
  expect(new Set(finalShas).size).toBe(2);
  for (const sha of finalShas) {
    expect(sha).not.toBeNull();
    expect(sha).not.toBe(entry.fixture.base_sha);
  }

  for (const ep of episodes) {
    expect(ep.repo.base_sha).toBe(entry.fixture.base_sha);
    expect(ep.fixture_ref).toEqual({
      family_id: "fam-syn-contract-validator",
      variant_id: "v1",
    });
    expect(ep.design).toBe("controlled");
    expect(ep.split).toBe("dev");
    expect(ep.family_id).toBe("fam-syn-contract-validator");
    expect(ep.lineage).toEqual({ root_handoff_id: null, handoff_ids: [], shape: "fixture" });
    expect(ep.attempt_history).toEqual({
      status: "complete",
      reason: null,
      count: 1,
      count_basis: "fixture_replay",
    });
    expect(ep.attempts).toHaveLength(1);
    expect(ep.attempts[0]?.n).toBe(1);
    expect(ep.attempts[0]?.head_sha).toBe(ep.final_sha);
    expect(ep.observed_outcome).toEqual({ class: "terminal_unverified" });
  }

  expect(goodEp.labels["replay_patch"]).toBe("good");
  expect(goodEp.attempts[0]?.handoff_id).toBe("replay:v1:good");
  expect(badEp.labels["replay_patch"]).toBe("bad-0");
  expect(badEp.attempts[0]?.handoff_id).toBe("replay:v1:bad-0");

  const replayed = await replay().buildReplayEpisodes([entry], { scratch });
  expect(replayed).toEqual(eps);
  expect(snapshotTree(corpusDir)).toEqual(snapshotBefore);
});

test("graded replay receipts verify: good -> pass, bad -> fail hidden_failed", async () => {
  const scratch = await mkScratch();
  const entry = await loadEntry(scratch);
  const { bundle: entryBundle } = requireParts(entry);
  const episodes = toEpisodes(await replay().buildReplayEpisodes([entry], { scratch }));
  expect(episodes).toHaveLength(2);
  const goodEp = episodes[0]!;
  const badEp = episodes[1]!;

  const buildId = "a".repeat(64);
  const cacheDir = mkTmp("penumbra-replay-deps-");
  mkdirSync(join(cacheDir, "node_modules"), { recursive: true });
  const deps: DependencyProvider = {
    ensure: () => Promise.resolve({ ok: true, cacheDir }),
  };
  const controls = new ControlCache({
    scratch,
    sandbox: "none",
    deps,
    buildId,
    timeoutMs: 20_000,
  });
  const gradeFn = (input: GradeInput, bundle: HoldoutBundle): Promise<GradeResult> =>
    grade(input, {
      bundle,
      scratch,
      controls,
      deps,
      sandbox: "none",
      timeoutMs: 20_000,
    });
  const lock: HoldoutLock = {
    schema_version: 1,
    entries: [],
    digest: computeLockDigest([]),
  };
  const ctx: VerifyContext = {
    lock,
    publicFixtures: [{ fixture: entry.fixture, bundle: entryBundle }],
    store: { readEntry: () => Promise.reject(new Error("store must not be read")) },
    scratch,
    controls,
    allowlist: { builds: [{ id: buildId, note: "replay-test" }] },
    grade: gradeFn,
    buildId,
  };

  const goodClaim = await gradeFn(gradeInputFor(goodEp), entryBundle);
  expect("ungradeable" in goodClaim).toBe(false);
  const goodRes = await verifyReceipt(goodClaim, goodEp, ctx);
  expect(goodRes).toMatchObject({
    status: "verified",
    verdict: "pass",
    fail_reason: null,
    sha: goodEp.final_sha,
  });

  const badClaim = await gradeFn(gradeInputFor(badEp), entryBundle);
  expect("ungradeable" in badClaim).toBe(false);
  const badRes = await verifyReceipt(badClaim, badEp, ctx);
  expect(badRes).toMatchObject({
    status: "verified",
    verdict: "fail",
    fail_reason: "hidden_failed",
    sha: badEp.final_sha,
  });
}, 120_000);

test("a fixture whose repo files drifted from base_sha makes buildReplayEpisodes throw", async () => {
  const scratch = await mkScratch();
  const entry = await loadEntry(scratch);
  const { repoFiles, bundle } = requireParts(entry);
  const driftedRepoFiles: Record<string, string> = {
    ...repoFiles,
    "src/validate.ts": `${repoFiles["src/validate.ts"] ?? ""}\n// drift\n`,
  };
  const drifted: CorpusFixture = {
    ...entry,
    repoFiles: driftedRepoFiles,
    bundle: { ...bundle, repo_files: driftedRepoFiles },
  };
  const mod = replay();
  const err = await catchErr(() => mod.buildReplayEpisodes([drifted], { scratch }));
  expect(err).toBeInstanceOf(Error);
  expect(errMsg(err)).toMatch(/base_sha mismatch/);
});

test("bundle-less (holdout) fixtures replay only through an open store session", async () => {
  const scratch = await mkScratch();
  const entry = await loadEntry(scratch);
  const { bundle } = requireParts(entry);
  const hidden: CorpusFixture = { ...entry, bundle: null, repoFiles: null };
  const lockEntry: HoldoutLockEntry = {
    family_id: entry.fixture.family_id,
    variant_id: entry.fixture.variant_id,
    root: entry.fixture.root,
    failure_type: entry.fixture.failure_type,
    synthetic: entry.fixture.synthetic,
    expect_blocked: entry.fixture.expect_blocked,
    base_sha: entry.fixture.base_sha,
    task_digest: entry.fixture.task_digest,
    source_root_handoff_digests: entry.fixture.source_root_handoff_digests,
    content_digest: entry.fixture.content_digest,
    assertion_set_digest: entry.fixture.hidden_ref.assertion_set_digest,
  };
  const lock: HoldoutLock = {
    schema_version: 1,
    entries: [lockEntry],
    digest: computeLockDigest([lockEntry]),
  };

  const mod = replay();
  const noStoreErr = await catchErr(() => mod.buildReplayEpisodes([hidden], { scratch, lock }));
  expect(noStoreErr).toBeInstanceOf(Error);
  expect(errMsg(noStoreErr)).toMatch(/holdout store/);

  const closedReads: HoldoutLockEntry[] = [];
  const closedErr = await catchErr(() =>
    mod.buildReplayEpisodes([hidden], {
      scratch,
      lock,
      store: {
        sessionId: null,
        readEntry: (arg: HoldoutLockEntry): Promise<HoldoutBundle> => {
          closedReads.push(arg);
          return Promise.resolve(bundle);
        },
      },
    }),
  );
  expect(closedErr).toBeInstanceOf(Error);
  expect(errMsg(closedErr)).toMatch(/holdout store/);
  expect(closedReads).toHaveLength(0);

  const openReads: HoldoutLockEntry[] = [];
  const holdoutEps = await mod.buildReplayEpisodes([hidden], {
    scratch,
    lock,
    store: {
      sessionId: "s-1",
      readEntry: (arg: HoldoutLockEntry): Promise<HoldoutBundle> => {
        openReads.push(arg);
        return Promise.resolve(bundle);
      },
    },
  });
  expect(holdoutEps).toHaveLength(2);
  for (const ep of holdoutEps) {
    expect(EpisodeSchema.safeParse(ep).success).toBe(true);
  }
  expect(openReads).toHaveLength(1);
  expect(openReads[0]?.family_id).toBe(entry.fixture.family_id);
  expect(openReads[0]?.variant_id).toBe(entry.fixture.variant_id);

  const publicEpisodes = toEpisodes(await mod.buildReplayEpisodes([entry], { scratch }));
  const holdoutEpisodes = toEpisodes(holdoutEps);
  expect(holdoutEpisodes.map((ep) => ep.final_sha).toSorted()).toEqual(
    publicEpisodes.map((ep) => ep.final_sha).toSorted(),
  );
});
