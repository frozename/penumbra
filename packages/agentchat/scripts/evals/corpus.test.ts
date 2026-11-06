import { canonicalJson, taskDigest } from "@penumbra/core/evals/canonical";
import {
  assertionSetDigest,
  bundleContentDigest,
  type FixturePublic,
  FixturePublicSchema,
  type HoldoutBundle,
  HoldoutBundleSchema,
  type HoldoutLock,
} from "@penumbra/core/evals/fixture";
import { computeLockDigest, HoldoutReservationError } from "@penumbra/core/evals/holdout";
import { assertNoFamilyLeak } from "@penumbra/core/evals/split";
import { afterEach, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { DependencyProvider } from "./grader/deps.js";

import { ControlCache } from "./grader/control.js";
import { seededShuffle } from "./grader/evaluate.js";
import { type GraderScratch, openGraderScratch } from "./grader/scratch.js";

interface SanitizerModule {
  isSanitized(value: unknown): boolean;
}

interface CorpusFixture {
  dir: string;
  fixture: FixturePublic;
  repoFiles: Record<string, string> | null;
  bundle: HoldoutBundle | null;
}

interface CorpusModule {
  DEFAULT_CORPUS_ROOT: string;
  CorpusLintError: abstract new (...args: never[]) => Error;
  lintCorpus(
    root: string,
    opts: { scratch: GraderScratch; lock?: HoldoutLock },
  ): Promise<CorpusFixture[]>;
  holdoutMetricFixtures(fixtures: readonly FixturePublic[]): FixturePublic[];
}

const CORPUS_URL = new URL("./corpus.ts", import.meta.url).href;
const SANITIZE_URL = new URL("./sanitize.ts", import.meta.url).href;

const CORPUS_ROOT = join(import.meta.dir, "..", "..", "test", "fixtures", "evals");

let corpusMod: CorpusModule | null = null;
let sanitizeMod: SanitizerModule | null = null;

beforeAll(async () => {
  corpusMod = (await import(CORPUS_URL).catch(() => null)) as CorpusModule | null;
  sanitizeMod = (await import(SANITIZE_URL).catch(() => null)) as SanitizerModule | null;
});

function corpus(): CorpusModule {
  expect(corpusMod).not.toBeNull();
  return corpusMod!;
}

function san(): SanitizerModule {
  expect(sanitizeMod).not.toBeNull();
  return sanitizeMod!;
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

function copyCorpus(): string {
  const dst = mkTmp("penumbra-corpus-");
  cpSync(corpus().DEFAULT_CORPUS_ROOT, dst, { recursive: true });
  return dst;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function catchErr(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return null;
}

async function resolvesOk(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface PinnedFixture {
  dir: string;
  failureType: FixturePublic["failure_type"];
  reconstructs: FixturePublic["reconstructs"];
  task: string;
}

const PINNED: readonly PinnedFixture[] = [
  {
    dir: "syn-contract-validator",
    failureType: null,
    reconstructs: null,
    task: "Implement the contract validator described by test/validate.test.ts.",
  },
  {
    dir: "syn-missed-commit",
    failureType: "missed_commit",
    reconstructs: { kind: "issue", number: 379 },
    task: "Implement commit attribution described by test/attribution.test.ts.",
  },
  {
    dir: "syn-model-identity",
    failureType: "wrong_model_identity",
    reconstructs: { kind: "issue", number: 328 },
    task: "Implement effective model identity described by test/identity.test.ts.",
  },
  {
    dir: "syn-hook-gap",
    failureType: "hook_bootstrap_gap",
    reconstructs: { kind: "issue", number: 217 },
    task: "Implement hook bootstrap checks described by test/bootstrap.test.ts.",
  },
  {
    dir: "syn-lane-gate-evidence",
    failureType: null,
    reconstructs: null,
    task: "Implement lane gate evidence described by test/gate.test.ts.",
  },
];

const NEW_BUNDLE_DIRS = PINNED.slice(1).map((entry) => entry.dir);
const SELF_QUALIFY_DIRS = [
  "syn-missed-commit",
  "syn-model-identity",
  "syn-hook-gap",
  "syn-lane-gate-evidence",
];

function fixturePaths(
  root: string,
  dir: string,
): {
  dir: string;
  fixture: string;
  repo: string;
  bundle: string;
} {
  const base = join(root, "synthetic", dir);
  return {
    dir: base,
    fixture: join(base, "fixture.json"),
    repo: join(base, "repo.files.json"),
    bundle: join(base, "bundle.json"),
  };
}

interface LoadedFixture {
  fixture: FixturePublic;
  repoFiles: Record<string, string>;
  bundle: HoldoutBundle;
}

function loadPinned(root: string, dir: string): LoadedFixture {
  const paths = fixturePaths(root, dir);
  expect(existsSync(paths.fixture)).toBe(true);
  expect(existsSync(paths.repo)).toBe(true);
  expect(existsSync(paths.bundle)).toBe(true);
  const parsed = FixturePublicSchema.safeParse(readJson(paths.fixture));
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error(`fixture ${dir} failed FixturePublicSchema`);
  }
  const repoFiles = readJson(paths.repo) as Record<string, string>;
  const bundle = HoldoutBundleSchema.parse({
    ...readJson(paths.bundle),
    repo_files: repoFiles,
  });
  return { fixture: parsed.data, repoFiles, bundle };
}

function expectPinnedFields(loaded: LoadedFixture, dir: string): void {
  const entry = PINNED.find((p) => p.dir === dir);
  expect(entry).not.toBeUndefined();
  if (entry === undefined) {
    return;
  }
  const { fixture } = loaded;
  expect(fixture.family_id).toBe(`fam-${dir}`);
  expect(fixture.variant_id).toBe("v1");
  expect(fixture.root).toEqual({ kind: "synthetic", id: dir.slice("syn-".length) });
  expect(fixture.reconstructs).toEqual(entry.reconstructs);
  expect(fixture.failure_type).toBe(entry.failureType);
  expect(fixture.split).toBe("dev");
  expect(fixture.synthetic).toBe(true);
  expect(fixture.expect_blocked).toBe(false);
  expect(fixture.task_digest).toBe(taskDigest(entry.task));
}

function jsonFilesUnder(root: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, ent.name);
    if (ent.isDirectory()) {
      out.push(...jsonFilesUnder(path));
    } else if (ent.name.endsWith(".json")) {
      out.push(path);
    }
  }
  return out;
}

function plantedNonSyntheticFixture(split: "dev" | "holdout"): FixturePublic {
  return {
    schema_version: 1,
    family_id: "fam-9001",
    variant_id: "v1",
    root: { kind: "issue", number: 9001 },
    reconstructs: null,
    failure_type: "missed_commit",
    split,
    synthetic: false,
    base_sha: "a".repeat(40),
    task_digest: taskDigest("planted 9001"),
    source_root_handoff_digests: [],
    expect_blocked: false,
    hidden_ref: { assertion_set_digest: "b".repeat(64) },
    content_digest: "c".repeat(64),
  };
}

function inMemoryHoldoutFixture(): FixturePublic {
  return {
    schema_version: 1,
    family_id: "fam-9101",
    variant_id: "v1",
    root: { kind: "issue", number: 9101 },
    reconstructs: null,
    failure_type: "missed_commit",
    split: "holdout",
    synthetic: false,
    base_sha: "a".repeat(40),
    task_digest: taskDigest("in-memory holdout"),
    source_root_handoff_digests: [],
    expect_blocked: false,
    hidden_ref: { assertion_set_digest: "b".repeat(64) },
    content_digest: "c".repeat(64),
  };
}

function testLock(): HoldoutLock {
  const entry: HoldoutLock["entries"][number] = {
    family_id: "fam-op-canary",
    variant_id: "v1",
    root: { kind: "operator_bundle", id: "canary" },
    failure_type: "missed_commit",
    synthetic: false,
    expect_blocked: false,
    base_sha: "d".repeat(40),
    task_digest: taskDigest("canary"),
    source_root_handoff_digests: [],
    content_digest: "e".repeat(64),
    assertion_set_digest: "f".repeat(64),
  };
  return { schema_version: 1, entries: [entry], digest: computeLockDigest([entry]) };
}

function rewriteFixtureJson(dir: string, mutate: (fixture: Record<string, unknown>) => void): void {
  const fixture = readJson(join(dir, "fixture.json"));
  mutate(fixture);
  writeJsonFile(join(dir, "fixture.json"), fixture);
}

function rewriteBundleFamily(dir: string, familyId: string): HoldoutBundle {
  const repoFiles = readJson(join(dir, "repo.files.json")) as Record<string, string>;
  const bundleJson = readJson(join(dir, "bundle.json"));
  bundleJson.family_id = familyId;
  writeJsonFile(join(dir, "bundle.json"), bundleJson);
  return HoldoutBundleSchema.parse({ ...bundleJson, repo_files: repoFiles });
}

function refreshDigests(dir: string, bundle: HoldoutBundle, extra: Record<string, unknown>): void {
  rewriteFixtureJson(dir, (fixture) => {
    fixture.hidden_ref = { assertion_set_digest: assertionSetDigest(bundle) };
    fixture.content_digest = bundleContentDigest(bundle);
    for (const [key, value] of Object.entries(extra)) {
      fixture[key] = value;
    }
  });
}

function rewriteBundleIdentity(
  dir: string,
  field: "family_id" | "variant_id",
  value: string,
): HoldoutBundle {
  const repoFiles = readJson(join(dir, "repo.files.json")) as Record<string, string>;
  const bundleJson = readJson(join(dir, "bundle.json"));
  bundleJson[field] = value;
  writeJsonFile(join(dir, "bundle.json"), bundleJson);
  return HoldoutBundleSchema.parse({ ...bundleJson, repo_files: repoFiles });
}

function flipHex(digest: string): string {
  return (digest.startsWith("a") ? "b" : "a") + digest.slice(1);
}

for (const entry of PINNED) {
  test(`corpus fixture ${entry.dir} exists, parses, and matches the pinned table`, async () => {
    const loaded = loadPinned(corpus().DEFAULT_CORPUS_ROOT, entry.dir);
    expectPinnedFields(loaded, entry.dir);
    const scratch = await mkScratch();
    const base = await scratch.buildBase(loaded.repoFiles);
    expect(loaded.fixture.base_sha).toBe(base);
    expect(loaded.fixture.hidden_ref.assertion_set_digest).toBe(assertionSetDigest(loaded.bundle));
    expect(loaded.fixture.content_digest).toBe(bundleContentDigest(loaded.bundle));
    expect(loaded.bundle.family_id).toBe(loaded.fixture.family_id);
    expect(loaded.bundle.variant_id).toBe(loaded.fixture.variant_id);
  }, 60_000);
}

test("every .json file under the corpus root is sanitized", () => {
  const files = jsonFilesUnder(corpus().DEFAULT_CORPUS_ROOT);
  expect(files.length).toBeGreaterThan(0);
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    expect(() => JSON.parse(text) as unknown).not.toThrow();
    expect(san().isSanitized(JSON.parse(text) as unknown)).toBe(true);
  }
});

test("lintCorpus resolves the real corpus without family leaks", async () => {
  const m = corpus();
  expect(resolve(m.DEFAULT_CORPUS_ROOT)).toBe(resolve(CORPUS_ROOT));
  const scratch = await mkScratch();
  const fixtures = await m.lintCorpus(m.DEFAULT_CORPUS_ROOT, { scratch });
  const ids = fixtures.map((f) => f.fixture.family_id);
  for (const entry of PINNED) {
    expect(ids).toContain(`fam-${entry.dir}`);
  }
  expect(() => {
    assertNoFamilyLeak(
      fixtures.map((f) => ({
        family_id: f.fixture.family_id,
        split: f.fixture.split,
        base_sha: f.fixture.base_sha,
        task_digest: f.fixture.task_digest,
      })),
    );
  }).not.toThrow();
});

function loadBundleForDir(dir: string): HoldoutBundle {
  const paths = fixturePaths(corpus().DEFAULT_CORPUS_ROOT, dir);
  expect(existsSync(paths.bundle)).toBe(true);
  expect(existsSync(paths.repo)).toBe(true);
  const repoFiles = readJson(paths.repo) as Record<string, string>;
  return HoldoutBundleSchema.parse({ ...readJson(paths.bundle), repo_files: repoFiles });
}

function orderInsensitiveChecks(
  bundle: HoldoutBundle,
): { seed: number; inputs: readonly unknown[] }[] {
  const out: { seed: number; inputs: readonly unknown[] }[] = [];
  for (const assertion of bundle.assertions) {
    if (assertion.kind === "invariant" && assertion.property === "order_insensitive") {
      out.push({ seed: assertion.seed, inputs: assertion.inputs });
    }
  }
  return out;
}

function expectShufflePermutes(seed: number, input: unknown): void {
  expect(Array.isArray(input)).toBe(true);
  if (!Array.isArray(input)) {
    return;
  }
  expect(canonicalJson(seededShuffle(input, seed))).not.toBe(canonicalJson(input));
}

test("order_insensitive assertion seeds really permute their inputs", () => {
  for (const dir of NEW_BUNDLE_DIRS) {
    for (const check of orderInsensitiveChecks(loadBundleForDir(dir))) {
      for (const input of check.inputs) {
        expectShufflePermutes(check.seed, input);
      }
    }
  }
});

test("lintCorpus rejects a fixture whose base_sha no longer matches its repo files", async () => {
  const scratch = await mkScratch();
  const tmp = copyCorpus();
  const dir = join(tmp, "synthetic", "syn-missed-commit");
  const repoPath = join(dir, "repo.files.json");
  const repoFiles = readJson(repoPath) as Record<string, string>;
  const keys = Object.keys(repoFiles).sort();
  const target = keys.find((path) => path.endsWith(".ts")) ?? keys[0];
  expect(target).not.toBeUndefined();
  repoFiles[target!] = `${repoFiles[target!] ?? ""}// edited\n`;
  writeJsonFile(repoPath, repoFiles);

  const bundle = HoldoutBundleSchema.parse({
    ...readJson(join(dir, "bundle.json")),
    repo_files: repoFiles,
  });
  rewriteFixtureJson(dir, (fixture) => {
    fixture.content_digest = bundleContentDigest(bundle);
  });

  const err = await catchErr(() => corpus().lintCorpus(tmp, { scratch }));
  expect(err).toBeInstanceOf(corpus().CorpusLintError);
  expect(errMsg(err)).toContain("base_sha");
});

test("lintCorpus rejects a malformed rows.json", async () => {
  const scratch = await mkScratch();
  const tmp = copyCorpus();
  writeJsonFile(join(tmp, "synthetic", "syn-contract-validator", "rows.json"), {});
  const err = await catchErr(() => corpus().lintCorpus(tmp, { scratch }));
  expect(err).toBeInstanceOf(corpus().CorpusLintError);
  expect(errMsg(err)).toContain("invalid_rows");
  expect(errMsg(err)).toContain("rows.json");
  expect(errMsg(err)).not.toContain("not_sanitized");
});

test("lintCorpus rejects an unsanitized fixture-dir file that carries an expected name", async () => {
  const scratch = await mkScratch();
  const tmp = copyCorpus();
  const dir = join(tmp, "synthetic", "syn-missed-commit");
  const repoPath = join(dir, "repo.files.json");
  const repoFiles = readJson(repoPath) as Record<string, string>;
  const target = Object.keys(repoFiles).toSorted()[0];
  expect(target).not.toBeUndefined();
  repoFiles[target!] = `${repoFiles[target!] ?? ""}\nhome /Users/alice/x\n`;
  writeJsonFile(repoPath, repoFiles);
  const err = await catchErr(() => corpus().lintCorpus(tmp, { scratch }));
  expect(err).toBeInstanceOf(corpus().CorpusLintError);
  expect(errMsg(err)).toContain("not_sanitized");
  expect(errMsg(err)).toContain("repo.files.json");
});

test("lintCorpus collects malformed JSON as a lint problem instead of throwing", async () => {
  const scratch = await mkScratch();
  const tmp = copyCorpus();
  writeFileSync(join(tmp, "synthetic", "syn-contract-validator", "fixture.json"), "{not json");
  const err = await catchErr(() => corpus().lintCorpus(tmp, { scratch }));
  expect(err).toBeInstanceOf(corpus().CorpusLintError);
  expect(errMsg(err)).toContain("invalid_json");
  expect(errMsg(err)).toContain("fixture.json");
});

test("lintCorpus rejects a fixture whose assertion_set_digest drifted from its bundle", async () => {
  const scratch = await mkScratch();
  const tmp = copyCorpus();
  const dir = join(tmp, "synthetic", "syn-missed-commit");
  rewriteFixtureJson(dir, (fixture) => {
    const hiddenRef = fixture.hidden_ref as Record<string, unknown>;
    hiddenRef.assertion_set_digest = flipHex(String(hiddenRef.assertion_set_digest));
  });
  const err = await catchErr(() => corpus().lintCorpus(tmp, { scratch }));
  expect(err).toBeInstanceOf(corpus().CorpusLintError);
  expect(errMsg(err)).toContain("assertion_set_digest mismatch");
  expect(errMsg(err)).toContain("syn-missed-commit");
  expect(errMsg(err)).not.toContain("content_digest");
});

test("lintCorpus rejects a fixture whose content_digest drifted from its bundle", async () => {
  const scratch = await mkScratch();
  const tmp = copyCorpus();
  const dir = join(tmp, "synthetic", "syn-missed-commit");
  rewriteFixtureJson(dir, (fixture) => {
    fixture.content_digest = flipHex(String(fixture.content_digest));
  });
  const err = await catchErr(() => corpus().lintCorpus(tmp, { scratch }));
  expect(err).toBeInstanceOf(corpus().CorpusLintError);
  expect(errMsg(err)).toContain("content_digest mismatch");
  expect(errMsg(err)).not.toContain("assertion_set_digest");
});

for (const field of ["family_id", "variant_id"] as const) {
  test(`lintCorpus rejects a bundle whose ${field} diverges from its fixture`, async () => {
    const scratch = await mkScratch();
    const tmp = copyCorpus();
    const dir = join(tmp, "synthetic", "syn-hook-gap");
    const bundle = rewriteBundleIdentity(
      dir,
      field,
      field === "family_id" ? "fam-syn-rewired" : "v2",
    );
    refreshDigests(dir, bundle, {});
    const err = await catchErr(() => corpus().lintCorpus(tmp, { scratch }));
    expect(err).toBeInstanceOf(corpus().CorpusLintError);
    expect(errMsg(err)).toContain("bundle_identity_mismatch");
    expect(errMsg(err)).toContain("syn-hook-gap");
    expect(errMsg(err)).not.toContain("digest mismatch");
  });
}

test("lintCorpus rejects non-synthetic fixtures that carry a public bundle", async () => {
  const scratch = await mkScratch();
  const tmp = copyCorpus();
  const dir = join(tmp, "synthetic", "real-9001");
  mkdirSync(dir, { recursive: true });
  const bundleSrc = fixturePaths(corpus().DEFAULT_CORPUS_ROOT, "syn-contract-validator").bundle;
  expect(existsSync(bundleSrc)).toBe(true);
  const fixture = plantedNonSyntheticFixture("holdout");
  expect(FixturePublicSchema.safeParse(fixture).success).toBe(true);

  writeJsonFile(join(dir, "fixture.json"), fixture);
  cpSync(bundleSrc, join(dir, "bundle.json"));
  let err = await catchErr(() => corpus().lintCorpus(tmp, { scratch }));
  expect(err).toBeInstanceOf(corpus().CorpusLintError);
  expect(errMsg(err)).toContain("non_synthetic_bundle");
  expect(errMsg(err)).toContain("bundle.json");

  writeJsonFile(join(dir, "fixture.json"), plantedNonSyntheticFixture("dev"));
  err = await catchErr(() => corpus().lintCorpus(tmp, { scratch }));
  expect(err).toBeInstanceOf(corpus().CorpusLintError);
  expect(errMsg(err)).toContain("non_synthetic_bundle");

  rmSync(join(dir, "bundle.json"));
  const ok = await resolvesOk(() => corpus().lintCorpus(tmp, { scratch }));
  expect(ok).toBe(true);
});

test("lintCorpus accepts a synthetic holdout and holdoutMetricFixtures keeps only real holdouts", async () => {
  const scratch = await mkScratch();
  const tmp = copyCorpus();
  const srcPaths = fixturePaths(corpus().DEFAULT_CORPUS_ROOT, "syn-contract-validator");
  const dstDir = join(tmp, "synthetic", "syn-holdout-planted");
  cpSync(srcPaths.dir, dstDir, { recursive: true });
  const bundle = rewriteBundleFamily(dstDir, "fam-syn-holdout-planted");
  refreshDigests(dstDir, bundle, {
    family_id: "fam-syn-holdout-planted",
    root: { kind: "synthetic", id: "holdout-planted" },
    split: "holdout",
    task_digest: taskDigest("planted holdout"),
  });

  const fixtures = await corpus().lintCorpus(tmp, { scratch });
  const inMemory = inMemoryHoldoutFixture();
  const metrics = corpus().holdoutMetricFixtures([...fixtures.map((f) => f.fixture), inMemory]);
  expect(metrics).toEqual([inMemory]);
});

test("lintCorpus accepts the real corpus under a holdout lock", async () => {
  const scratch = await mkScratch();
  const ok = await resolvesOk(() =>
    corpus().lintCorpus(corpus().DEFAULT_CORPUS_ROOT, { scratch, lock: testLock() }),
  );
  expect(ok).toBe(true);
});

test("lintCorpus rejects a synthetic fixture reconstructing a reserved lock root", async () => {
  const scratch = await mkScratch();
  const tmp = copyCorpus();
  const srcPaths = fixturePaths(corpus().DEFAULT_CORPUS_ROOT, "syn-missed-commit");
  const dstDir = join(tmp, "synthetic", "syn-canary-recon");
  cpSync(srcPaths.dir, dstDir, { recursive: true });
  const bundle = rewriteBundleFamily(dstDir, "fam-syn-canary-recon");
  refreshDigests(dstDir, bundle, {
    family_id: "fam-syn-canary-recon",
    root: { kind: "synthetic", id: "canary-recon" },
    reconstructs: { kind: "operator_bundle", id: "canary" },
    task_digest: taskDigest("canary recon"),
  });

  const err = await catchErr(() => corpus().lintCorpus(tmp, { scratch, lock: testLock() }));
  expect(err).toBeInstanceOf(HoldoutReservationError);
});

test("lintCorpus rejects non-.json files outside fixture dirs", async () => {
  const scratch = await mkScratch();
  const tmp = copyCorpus();
  writeFileSync(join(tmp, "notes.ts"), "export {};\n");
  const err = await catchErr(() => corpus().lintCorpus(tmp, { scratch }));
  expect(err).toBeInstanceOf(corpus().CorpusLintError);
  expect(errMsg(err)).toContain("non_json_file");
  expect(errMsg(err)).toContain("notes.ts");
});

test("lintCorpus ignores .DS_Store OS junk", async () => {
  const scratch = await mkScratch();
  const tmp = copyCorpus();
  writeFileSync(join(tmp, ".DS_Store"), "junk");
  const ok = await resolvesOk(() => corpus().lintCorpus(tmp, { scratch }));
  expect(ok).toBe(true);
});

for (const dir of SELF_QUALIFY_DIRS) {
  test(`control self-qualifies corpus fixture ${dir}`, async () => {
    const scratch = await mkScratch();
    const fixtureDir = join(corpus().DEFAULT_CORPUS_ROOT, "synthetic", dir);
    expect(existsSync(join(fixtureDir, "bundle.json"))).toBe(true);
    expect(existsSync(join(fixtureDir, "repo.files.json"))).toBe(true);
    const repoFiles = readJson(join(fixtureDir, "repo.files.json")) as Record<string, string>;
    const bundle = HoldoutBundleSchema.parse({
      ...readJson(join(fixtureDir, "bundle.json")),
      repo_files: repoFiles,
    });
    const cacheDir = mkTmp("penumbra-corpus-deps-");
    mkdirSync(join(cacheDir, "node_modules"), { recursive: true });
    const deps: DependencyProvider = {
      ensure: () => Promise.resolve({ ok: true, cacheDir }),
    };
    const controls = new ControlCache({
      scratch,
      sandbox: "none",
      deps,
      buildId: "corpus-test",
      timeoutMs: 20_000,
    });
    const outcome = await controls.ensure(
      { family_id: bundle.family_id, variant_id: bundle.variant_id },
      bundle,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.control.verdict).toBe("pass");
    expect(outcome.self_qualification).toEqual({ ok: true });
  }, 120_000);
}
