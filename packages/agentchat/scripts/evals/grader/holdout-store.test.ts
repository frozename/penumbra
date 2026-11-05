import { sha256Hex } from "@penumbra/core/evals/canonical";
import {
  assertionSetDigest,
  bundleContentDigest,
  type HoldoutBundle,
  type HoldoutLock,
  type HoldoutLockEntry,
} from "@penumbra/core/evals/fixture";
import { computeLockDigest, unsealHoldout } from "@penumbra/core/evals/holdout";
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunCommand, RunCommandResult } from "./materialize.js";

// holdout-store.ts does not exist yet: the P10 surface is declared structurally
// below and the module is loaded dynamically so every case fails on the
// `expect(mod).not.toBeNull()` assertion at RED time instead of on a missing
// import (the same pattern grade.test.ts uses for grade.ts/control.ts).
type UnsealGrant = ReturnType<typeof unsealHoldout>;

interface HoldoutStoreSession {
  readEntry(entry: HoldoutLockEntry): Promise<HoldoutBundle>;
}

interface OpenHoldoutStoreOpts {
  storePath: string;
  lock: HoldoutLock;
  grant?: UnsealGrant;
  planPath?: string;
  runCommand?: RunCommand;
}

interface HoldoutStoreMismatch {
  family_id: string;
  variant_id: string;
  which: "content" | "assertion_set" | "missing";
}

interface HoldoutStoreVerifyResult {
  ok: boolean;
  mismatches: HoldoutStoreMismatch[];
}

interface HoldoutStoreApi {
  openHoldoutStore(opts: OpenHoldoutStoreOpts): Promise<HoldoutStoreSession>;
  verifyHoldoutStore(lock: HoldoutLock, storePath: string): Promise<HoldoutStoreVerifyResult>;
  HoldoutStoreError: new (...args: never[]) => Error & { code: string };
  UnsealExhausted: new (...args: never[]) => Error;
}

const HOLDOUT_STORE_URL = new URL("./holdout-store.ts", import.meta.url).href;

async function loadHoldoutStore(): Promise<HoldoutStoreApi> {
  const mod = (await import(HOLDOUT_STORE_URL).catch(() => null)) as HoldoutStoreApi | null;
  expect(mod).not.toBeNull();
  return mod!;
}

// --- fixtures -----------------------------------------------------------------

function mkBundle(familyId: string, variantId: string, n: number): HoldoutBundle {
  return {
    schema_version: 1,
    family_id: familyId,
    variant_id: variantId,
    repo_files: { "src/a.ts": `export const a = ${String(n)};\n` },
    assertions: [
      { kind: "probe", id: "c1", module: "src/a.ts", export: "a", input: null, expect: n },
    ],
    patches: { good: "good", bad: ["bad"] },
    mutants: [],
  };
}

function mkEntry(
  root: HoldoutLockEntry["root"],
  bundle: HoldoutBundle,
  synthetic: boolean,
): HoldoutLockEntry {
  return {
    family_id: bundle.family_id,
    variant_id: bundle.variant_id,
    root,
    failure_type: synthetic ? null : "missed_commit",
    synthetic,
    expect_blocked: false,
    base_sha: "a".repeat(40),
    task_digest: "b".repeat(64),
    source_root_handoff_digests: [],
    content_digest: bundleContentDigest(bundle),
    assertion_set_digest: assertionSetDigest(bundle),
  };
}

function mkLock(entries: HoldoutLockEntry[]): HoldoutLock {
  return { schema_version: 1, entries, digest: computeLockDigest(entries) };
}

function writeStore(dir: string, bundles: HoldoutBundle[]): void {
  for (const bundle of bundles) {
    const bundleDir = join(dir, bundleContentDigest(bundle));
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "bundle.json"), JSON.stringify(bundle), "utf8");
  }
}

// --- git helpers ---------------------------------------------------------------

const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

const COMMIT_IDENTITY = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@invalid",
  "-c",
  "commit.gpgsign=false",
];

function gitSync(cwd: string, args: string[]): void {
  const res = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: GIT_ENV,
  });
  expect(res.status).toBe(0);
}

interface PlanRepo {
  repoRoot: string;
  planPath: string;
  planSha: string;
}

function mkPlanRepo(opts: { track?: boolean } = {}): PlanRepo {
  const repoRoot = mkTmp("penumbra-holdout-plan-");
  gitSync(repoRoot, ["init", "-q"]);
  const planPath = join(repoRoot, "plan.md");
  writeFileSync(planPath, "# eval plan\n", "utf8");
  if (opts.track !== false) {
    gitSync(repoRoot, ["add", "plan.md"]);
    gitSync(repoRoot, [...COMMIT_IDENTITY, "commit", "-q", "-m", "plan"]);
  }
  return { repoRoot, planPath, planSha: sha256Hex(readFileSync(planPath)) };
}

// --- temp dirs -----------------------------------------------------------------

const tempDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- assertion helpers -----------------------------------------------------------

async function expectStoreCode(
  api: HoldoutStoreApi,
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(api.HoldoutStoreError);
  expect((caught as Error & { code?: unknown }).code).toBe(code);
}

function readAccessLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, "utf8").trim();
  if (text === "") {
    return [];
  }
  return text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectGrantedLine(line: Record<string, unknown>, planSha: string, counter: number): void {
  expect(Object.keys(line).sort()).toEqual(["counter", "granted", "plan_sha", "session_id", "ts"]);
  const ts = line["ts"];
  expect(typeof ts).toBe("string");
  if (typeof ts === "string") {
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  }
  expect(line["plan_sha"]).toBe(planSha);
  const sessionId = line["session_id"];
  expect(typeof sessionId).toBe("string");
  expect(typeof sessionId === "string" && sessionId.length > 0).toBe(true);
  expect(line["counter"]).toBe(counter);
  expect(line["granted"]).toBe(true);
}

// --- cases -----------------------------------------------------------------------

test("readEntry rejects entries outside the lock even when their bundle exists on disk", async () => {
  const api = await loadHoldoutStore();
  const storeDir = mkTmp("penumbra-holdout-store-");
  const planRepo = mkPlanRepo();
  const bundles = [mkBundle("fam-9001", "v1", 1), mkBundle("fam-9002", "v1", 2)];
  const entries = [
    mkEntry({ kind: "issue", number: 9001 }, bundles[0]!, false),
    mkEntry({ kind: "issue", number: 9002 }, bundles[1]!, false),
  ];
  const lock = mkLock(entries);
  writeStore(storeDir, bundles);
  const rogueBundle = mkBundle("fam-9003", "v1", 3);
  const rogueEntry = mkEntry({ kind: "issue", number: 9003 }, rogueBundle, false);
  writeStore(storeDir, [rogueBundle]);
  const grant = unsealHoldout(lock, { sha256: planRepo.planSha, max_unseals: 2 });
  const store = await api.openHoldoutStore({
    storePath: storeDir,
    lock,
    grant,
    planPath: planRepo.planPath,
  });

  await expectStoreCode(api, () => store.readEntry(rogueEntry), "entry_not_in_lock");

  const altEntry: HoldoutLockEntry = {
    ...entries[0]!,
    assertion_set_digest: "0".repeat(64),
  };
  await expectStoreCode(api, () => store.readEntry(altEntry), "entry_not_in_lock");
});

test("readEntry and verifyHoldoutStore detect content drift and missing bundles", async () => {
  const api = await loadHoldoutStore();
  const untamperedDir = mkTmp("penumbra-holdout-store-");
  const tamperedDir = mkTmp("penumbra-holdout-store-");
  const missingDir = mkTmp("penumbra-holdout-store-");
  const bundle = mkBundle("fam-syn-syn-store", "v1", 7);
  const entry = mkEntry({ kind: "synthetic", id: "syn-store" }, bundle, true);
  const lock = mkLock([entry]);
  writeStore(untamperedDir, [bundle]);
  writeStore(tamperedDir, [bundle]);
  writeStore(missingDir, [bundle]);

  const tamperedPath = join(tamperedDir, bundleContentDigest(bundle), "bundle.json");
  const drifted = JSON.parse(readFileSync(tamperedPath, "utf8")) as HoldoutBundle;
  const firstAssertion = drifted.assertions[0];
  expect(firstAssertion?.kind).toBe("probe");
  if (firstAssertion?.kind === "probe") {
    firstAssertion.expect = 999;
  }
  writeFileSync(tamperedPath, JSON.stringify(drifted), "utf8");
  rmSync(join(missingDir, bundleContentDigest(bundle)), { recursive: true, force: true });

  const untampered = await api.openHoldoutStore({ storePath: untamperedDir, lock });
  expect(await untampered.readEntry(entry)).toEqual(bundle);

  const tampered = await api.openHoldoutStore({ storePath: tamperedDir, lock });
  await expectStoreCode(api, () => tampered.readEntry(entry), "content_digest_mismatch");

  expect(await api.verifyHoldoutStore(lock, untamperedDir)).toEqual({
    ok: true,
    mismatches: [],
  });
  expect(await api.verifyHoldoutStore(lock, tamperedDir)).toEqual({
    ok: false,
    mismatches: [{ family_id: entry.family_id, variant_id: entry.variant_id, which: "content" }],
  });
  expect(await api.verifyHoldoutStore(lock, missingDir)).toEqual({
    ok: false,
    mismatches: [{ family_id: entry.family_id, variant_id: entry.variant_id, which: "missing" }],
  });
});

test("a lock entry whose assertion_set_digest does not match the bundle is rejected", async () => {
  const api = await loadHoldoutStore();
  const storeDir = mkTmp("penumbra-holdout-store-");
  const bundle = mkBundle("fam-syn-syn-store", "v1", 8);
  writeStore(storeDir, [bundle]);
  const goodEntry = mkEntry({ kind: "synthetic", id: "syn-store" }, bundle, true);
  const driftedEntry: HoldoutLockEntry = {
    ...goodEntry,
    assertion_set_digest: sha256Hex("not the assertion set"),
  };
  expect(driftedEntry.assertion_set_digest).not.toBe(assertionSetDigest(bundle));
  const lock = mkLock([driftedEntry]);
  const store = await api.openHoldoutStore({ storePath: storeDir, lock });

  await expectStoreCode(api, () => store.readEntry(driftedEntry), "assertion_set_digest_mismatch");
  expect(await api.verifyHoldoutStore(lock, storeDir)).toEqual({
    ok: false,
    mismatches: [
      {
        family_id: driftedEntry.family_id,
        variant_id: driftedEntry.variant_id,
        which: "assertion_set",
      },
    ],
  });
});

test("synthetic entries read without unseal while non-synthetic entries require it", async () => {
  const api = await loadHoldoutStore();
  const storeDir = mkTmp("penumbra-holdout-store-");
  const syntheticBundle = mkBundle("fam-syn-syn-store", "v1", 4);
  const issueBundle = mkBundle("fam-9001", "v1", 5);
  writeStore(storeDir, [syntheticBundle, issueBundle]);
  const syntheticEntry = mkEntry({ kind: "synthetic", id: "syn-store" }, syntheticBundle, true);
  const issueEntry = mkEntry({ kind: "issue", number: 9001 }, issueBundle, false);
  const lock = mkLock([syntheticEntry, issueEntry]);

  const store = await api.openHoldoutStore({ storePath: storeDir, lock });

  await expectStoreCode(api, () => store.readEntry(issueEntry), "unseal_required");
  expect(await store.readEntry(syntheticEntry)).toEqual(syntheticBundle);
  expect(existsSync(join(storeDir, "access.jsonl"))).toBe(false);
});

test("openHoldoutStore rejects untracked plans, plan sha mismatches, and lock digest mismatches", async () => {
  const api = await loadHoldoutStore();
  const storeDir = mkTmp("penumbra-holdout-store-");
  const bundle = mkBundle("fam-9001", "v1", 6);
  const entry = mkEntry({ kind: "issue", number: 9001 }, bundle, false);
  const lock = mkLock([entry]);
  writeStore(storeDir, [bundle]);

  const untrackedPlan = mkPlanRepo({ track: false });
  const untrackedGrant = unsealHoldout(lock, {
    sha256: untrackedPlan.planSha,
    max_unseals: 2,
  });
  await expectStoreCode(
    api,
    () =>
      api.openHoldoutStore({
        storePath: storeDir,
        lock,
        grant: untrackedGrant,
        planPath: untrackedPlan.planPath,
      }),
    "plan_untracked",
  );

  const shaPlan = mkPlanRepo();
  const shaGrant = unsealHoldout(lock, { sha256: shaPlan.planSha, max_unseals: 2 });
  writeFileSync(shaPlan.planPath, "# eval plan\nrevised\n", "utf8");
  await expectStoreCode(
    api,
    () =>
      api.openHoldoutStore({
        storePath: storeDir,
        lock,
        grant: shaGrant,
        planPath: shaPlan.planPath,
      }),
    "plan_sha_mismatch",
  );

  const lockPlan = mkPlanRepo();
  const lockGrant = {
    ...unsealHoldout(lock, { sha256: lockPlan.planSha, max_unseals: 2 }),
    lock_digest: "0".repeat(64),
  };
  await expectStoreCode(
    api,
    () =>
      api.openHoldoutStore({
        storePath: storeDir,
        lock,
        grant: lockGrant,
        planPath: lockPlan.planPath,
      }),
    "lock_digest_mismatch",
  );

  expect(existsSync(join(storeDir, "access.jsonl"))).toBe(false);
});

test("unseal sessions are capped by grant count, not by reads", async () => {
  const api = await loadHoldoutStore();
  const storeDir = mkTmp("penumbra-holdout-store-");
  const planRepo = mkPlanRepo();
  const bundles = [
    mkBundle("fam-9001", "v1", 1),
    mkBundle("fam-9002", "v1", 2),
    mkBundle("fam-9003", "v1", 3),
  ];
  const entries = [
    mkEntry({ kind: "issue", number: 9001 }, bundles[0]!, false),
    mkEntry({ kind: "issue", number: 9002 }, bundles[1]!, false),
    mkEntry({ kind: "issue", number: 9003 }, bundles[2]!, false),
  ];
  const lock = mkLock(entries);
  writeStore(storeDir, bundles);
  const grant = unsealHoldout(lock, { sha256: planRepo.planSha, max_unseals: 2 });
  const openOpts: OpenHoldoutStoreOpts = {
    storePath: storeDir,
    lock,
    grant,
    planPath: planRepo.planPath,
  };
  const accessPath = join(storeDir, "access.jsonl");

  const session1 = await api.openHoldoutStore(openOpts);
  for (let round = 0; round < 5; round += 1) {
    for (const [index, entry] of entries.entries()) {
      expect(await session1.readEntry(entry)).toEqual(bundles[index]!);
    }
  }
  let lines = readAccessLines(accessPath);
  expect(lines).toHaveLength(1);
  expectGrantedLine(lines[0]!, grant.analysis_plan_sha256, 1);
  const session1Id = lines[0]!["session_id"];

  const session2 = await api.openHoldoutStore(openOpts);
  expect(await session2.readEntry(entries[0]!)).toEqual(bundles[0]!);
  lines = readAccessLines(accessPath);
  expect(lines).toHaveLength(2);
  expectGrantedLine(lines[1]!, grant.analysis_plan_sha256, 2);
  const session2Id = lines[1]!["session_id"];
  expect(typeof session1Id).toBe("string");
  expect(typeof session2Id).toBe("string");
  expect(session2Id).not.toBe(session1Id);
  expect(typeof session2Id === "string" && session2Id.length > 0).toBe(true);

  let caught: unknown;
  try {
    await api.openHoldoutStore(openOpts);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(api.UnsealExhausted);
  expect((caught as Error).name).toBe("UnsealExhausted");

  lines = readAccessLines(accessPath);
  expect(lines).toHaveLength(3);
  expect(lines[0]!["granted"]).toBe(true);
  expect(lines[1]!["granted"]).toBe(true);
  const denied = lines[2]!;
  expect(Object.keys(denied).sort()).toEqual(["granted", "plan_sha", "session_id", "ts"]);
  expect(denied["granted"]).toBe(false);
  expect(denied["plan_sha"]).toBe(grant.analysis_plan_sha256);
  const deniedTs = denied["ts"];
  expect(typeof deniedTs).toBe("string");
  if (typeof deniedTs === "string") {
    expect(deniedTs).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  }
  const deniedSession = denied["session_id"];
  expect(typeof deniedSession).toBe("string");
  expect(typeof deniedSession === "string" && deniedSession.length > 0).toBe(true);
});

test("readEntry caches the loaded bundle for the session", async () => {
  const api = await loadHoldoutStore();
  const storeDir = mkTmp("penumbra-holdout-store-");
  const planRepo = mkPlanRepo();
  const bundle = mkBundle("fam-9001", "v1", 9);
  const entry = mkEntry({ kind: "issue", number: 9001 }, bundle, false);
  const lock = mkLock([entry]);
  writeStore(storeDir, [bundle]);
  const grant = unsealHoldout(lock, { sha256: planRepo.planSha, max_unseals: 2 });
  const store = await api.openHoldoutStore({
    storePath: storeDir,
    lock,
    grant,
    planPath: planRepo.planPath,
  });

  expect(await store.readEntry(entry)).toEqual(bundle);
  rmSync(join(storeDir, bundleContentDigest(bundle), "bundle.json"));
  expect(await store.readEntry(entry)).toEqual(bundle);

  const second = await api.openHoldoutStore({
    storePath: storeDir,
    lock,
    grant,
    planPath: planRepo.planPath,
  });
  let caught: unknown;
  try {
    await second.readEntry(entry);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
});

test("openHoldoutStore refuses store paths inside git work trees", async () => {
  const api = await loadHoldoutStore();
  const planRepo = mkPlanRepo();
  const lock = mkLock([]);

  const existingInside = join(planRepo.repoRoot, "store");
  mkdirSync(existingInside, { recursive: true });
  await expectStoreCode(
    api,
    () => api.openHoldoutStore({ storePath: existingInside, lock }),
    "store_in_repo",
  );

  const missingInside = join(planRepo.repoRoot, "new-store");
  await expectStoreCode(
    api,
    () => api.openHoldoutStore({ storePath: missingInside, lock }),
    "store_in_repo",
  );
  expect(existsSync(missingInside)).toBe(false);

  await expectStoreCode(
    api,
    () => api.openHoldoutStore({ storePath: "relative/store", lock }),
    "store_path_not_absolute",
  );

  const outside = mkTmp("penumbra-holdout-store-");
  const store = await api.openHoldoutStore({ storePath: outside, lock });
  expect(typeof store.readEntry).toBe("function");
});

test("openHoldoutStore fails closed when the git work-tree probe errors", async () => {
  const api = await loadHoldoutStore();
  const lock = mkLock([]);

  const failingRunner = (code: number, stdout: string, stderr: string): RunCommand => {
    const result: RunCommandResult = {
      code,
      stdout: Buffer.from(stdout, "utf8"),
      stderr: Buffer.from(stderr, "utf8"),
    };
    return () => Promise.resolve(result);
  };

  const dubiousDir = join(mkTmp("penumbra-holdout-probe-"), "store");
  await expectStoreCode(
    api,
    () =>
      api.openHoldoutStore({
        storePath: dubiousDir,
        lock,
        runCommand: failingRunner(
          128,
          "",
          "fatal: detected dubious ownership in repository at '/srv/repo'\n",
        ),
      }),
    "store_in_repo",
  );
  expect(existsSync(dubiousDir)).toBe(false);

  const missingGitDir = join(mkTmp("penumbra-holdout-probe-"), "store");
  await expectStoreCode(
    api,
    () =>
      api.openHoldoutStore({
        storePath: missingGitDir,
        lock,
        runCommand: failingRunner(-1, "", "Error: spawnSync git ENOENT\n"),
      }),
    "store_in_repo",
  );
  expect(existsSync(missingGitDir)).toBe(false);

  const garbageDir = join(mkTmp("penumbra-holdout-probe-"), "store");
  await expectStoreCode(
    api,
    () =>
      api.openHoldoutStore({
        storePath: garbageDir,
        lock,
        runCommand: failingRunner(0, "maybe\n", ""),
      }),
    "store_in_repo",
  );
  expect(existsSync(garbageDir)).toBe(false);

  const notARepoDir = join(mkTmp("penumbra-holdout-probe-"), "store");
  const store = await api.openHoldoutStore({
    storePath: notARepoDir,
    lock,
    runCommand: failingRunner(
      1,
      "",
      "fatal: not a git repository (or any of the parent directories): .git\n",
    ),
  });
  expect(typeof store.readEntry).toBe("function");
});

test("unseal budget counts only granted records toward max_unseals", async () => {
  const api = await loadHoldoutStore();
  const storeDir = mkTmp("penumbra-holdout-store-");
  const planRepo = mkPlanRepo();
  const bundle = mkBundle("fam-9001", "v1", 1);
  const entry = mkEntry({ kind: "issue", number: 9001 }, bundle, false);
  const lock = mkLock([entry]);
  writeStore(storeDir, [bundle]);
  const accessPath = join(storeDir, "access.jsonl");

  const tightGrant = unsealHoldout(lock, { sha256: planRepo.planSha, max_unseals: 1 });
  const openOpts = (grant: UnsealGrant): OpenHoldoutStoreOpts => ({
    storePath: storeDir,
    lock,
    grant,
    planPath: planRepo.planPath,
  });

  await api.openHoldoutStore(openOpts(tightGrant));
  let caught: unknown;
  try {
    await api.openHoldoutStore(openOpts(tightGrant));
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(api.UnsealExhausted);

  let lines = readAccessLines(accessPath);
  expect(lines).toHaveLength(2);
  expect(lines[0]!["granted"]).toBe(true);
  expect(lines[1]!["granted"]).toBe(false);

  const widerGrant = unsealHoldout(lock, { sha256: planRepo.planSha, max_unseals: 2 });
  await api.openHoldoutStore(openOpts(widerGrant));
  lines = readAccessLines(accessPath);
  expect(lines).toHaveLength(3);
  expectGrantedLine(lines[2]!, widerGrant.analysis_plan_sha256, 2);
});
