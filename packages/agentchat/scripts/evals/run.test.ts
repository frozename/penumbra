import { sha256Hex } from "@penumbra/core/evals/canonical";
import {
  assertionSetDigest,
  bundleContentDigest,
  familyIdForRoot,
  type HoldoutBundle,
  type HoldoutLock,
  type HoldoutLockEntry,
} from "@penumbra/core/evals/fixture";
import { computeLockDigest } from "@penumbra/core/evals/holdout";
import { EpisodeSchema } from "@penumbra/core/evals/manifest";
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DependencyProvider } from "./grader/deps.js";
import type { SandboxKind } from "./grader/sandbox.js";
import type { GraderAllowlist } from "./grader/verify.js";

import { DEFAULT_CORPUS_ROOT, lintCorpus } from "./corpus.js";
import { type GraderScratch, openGraderScratch } from "./grader/scratch.js";
import { openIngestDatabase } from "./ingest-db.js";

// run.ts does not exist yet: the P14 offline-eval CLI surface is declared
// structurally below and the module is loaded dynamically so every case
// fails on the `expect(runMod).not.toBeNull()` assertion at RED time instead
// of on a missing import (the same pattern replay.test.ts uses).
interface RunResult {
  code: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface RunDepsShape {
  now: () => number;
  storageRoot: string;
  buildId: () => Promise<string>;
  allowlist: () => GraderAllowlist;
  deps: () => DependencyProvider;
  sandbox: () => Promise<SandboxKind>;
  timeoutMs: number;
}

interface RunModule {
  runCli(argv: readonly string[], deps?: Partial<RunDepsShape>): Promise<RunResult>;
  BLOCKED_MESSAGE: string;
  AUTOCOMMIT_FLAG_SHA: string;
  resolveHarnessBuild(
    input: { design: "controlled" | "observational"; buildSha: string | null },
    isAncestor: (ancestor: string, descendant: string) => Promise<boolean>,
  ): Promise<{ sha: string | null; missing_reason?: string }>;
}

const RUN_URL = new URL("./run.ts", import.meta.url).href;
const RUN_PATH = fileURLToPath(new URL("./run.ts", import.meta.url));

let runMod: RunModule | null = null;

beforeAll(async () => {
  runMod = (await import(RUN_URL).catch(() => null)) as RunModule | null;
});

function run(): RunModule {
  expect(runMod).not.toBeNull();
  return runMod!;
}

// --- shared deps / fixtures ---------------------------------------------------

const NOW_MS = Date.parse("2026-06-20T00:00:00Z");
const BUILD_ID = "a".repeat(64);

const tempDirs: string[] = [];
const scratches: GraderScratch[] = [];

afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    scratch.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function gradingDeps(storageRoot: string): RunDepsShape {
  const cacheDir = mkTmp("penumbra-eval-deps-");
  mkdirSync(join(cacheDir, "node_modules"), { recursive: true });
  const provider: DependencyProvider = {
    ensure: () => Promise.resolve({ ok: true, cacheDir }),
  };
  return {
    now: () => NOW_MS,
    storageRoot,
    buildId: () => Promise.resolve(BUILD_ID),
    allowlist: () => ({ builds: [{ id: BUILD_ID, note: "p14" }] }),
    deps: () => provider,
    sandbox: () => Promise.resolve("none"),
    timeoutMs: 20_000,
  };
}

// --- seeded sqlite copies -----------------------------------------------------

interface SeedHandoffRow {
  handoff_id: string;
  ts: string;
  message: string;
  parent_handoff_id: string | null;
  triggered_by_event_id: string | null;
  branch_base: string | null;
  branch_name: string | null;
  workflow_run_id: string | null;
  dispatch_attempts: number;
}

interface SeedEventRow {
  id: number;
  handoff_id: string;
  worker_id: string | null;
  source: string;
  kind: string;
  ts: string;
  meta_json: string | null;
}

interface SeedLaneRow {
  lane_id: string;
  implementer_handoff: string;
  gate_status: string;
  ts_closed: string | null;
}

interface SeedRows {
  handoffs: SeedHandoffRow[];
  events: SeedEventRow[];
  retry_events?: { event_id: string; handoff_id: string }[];
  lanes?: SeedLaneRow[];
}

interface T0EventRow {
  event_id: string;
  ts: string;
  event_type: string;
  provider: string | null;
  model: string | null;
  cost_usd: number | null;
  payload_json: string;
}

const ROWS_PATH = join(DEFAULT_CORPUS_ROOT, "synthetic", "syn-missed-commit", "rows.json");

const T0_USAGE_ROW: T0EventRow = {
  event_id: "t0-usage-1",
  ts: "2026-06-12T12:30:00Z",
  event_type: "usage-update",
  provider: "p",
  model: "m",
  cost_usd: 0.5,
  payload_json: '{"handoff_id":"h-103","used":1234}',
};

function readSeedRows(): SeedRows {
  return JSON.parse(readFileSync(ROWS_PATH, "utf8")) as SeedRows;
}

function seedDb(dbPath: string, rows: SeedRows, opts: { t0Events?: T0EventRow[] } = {}): void {
  const db = new Database(dbPath);
  try {
    db.run(
      "CREATE TABLE handoffs(handoff_id TEXT PRIMARY KEY, ts TEXT, message TEXT, parent_handoff_id TEXT, triggered_by_event_id TEXT, branch_base TEXT, branch_name TEXT, workflow_run_id TEXT, dispatch_attempts INTEGER)",
    );
    db.run(
      "CREATE TABLE dispatch_events(id INTEGER PRIMARY KEY, handoff_id TEXT, worker_id TEXT, source TEXT, kind TEXT, ts TEXT, meta_json TEXT)",
    );
    const insHandoff = db.prepare(
      "INSERT INTO handoffs(handoff_id, ts, message, parent_handoff_id, triggered_by_event_id, branch_base, branch_name, workflow_run_id, dispatch_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const h of rows.handoffs) {
      insHandoff.run(
        h.handoff_id,
        h.ts,
        h.message,
        h.parent_handoff_id,
        h.triggered_by_event_id,
        h.branch_base,
        h.branch_name,
        h.workflow_run_id,
        h.dispatch_attempts,
      );
    }
    const insEvent = db.prepare(
      "INSERT INTO dispatch_events(id, handoff_id, worker_id, source, kind, ts, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of rows.events) {
      insEvent.run(e.id, e.handoff_id, e.worker_id, e.source, e.kind, e.ts, e.meta_json);
    }
    if (rows.lanes !== undefined && rows.lanes.length > 0) {
      db.run(
        "CREATE TABLE lane_ledger(lane_id TEXT PRIMARY KEY, implementer_handoff TEXT, gate_status TEXT, ts_closed TEXT)",
      );
      const insLane = db.prepare(
        "INSERT INTO lane_ledger(lane_id, implementer_handoff, gate_status, ts_closed) VALUES (?, ?, ?, ?)",
      );
      for (const lane of rows.lanes) {
        insLane.run(lane.lane_id, lane.implementer_handoff, lane.gate_status, lane.ts_closed);
      }
    }
    if (opts.t0Events !== undefined) {
      db.run(
        "CREATE TABLE t0_events(event_id TEXT PRIMARY KEY, ts TEXT, event_type TEXT, provider TEXT, model TEXT, cost_usd REAL, payload_json TEXT)",
      );
      const insT0 = db.prepare(
        "INSERT INTO t0_events(event_id, ts, event_type, provider, model, cost_usd, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const t0 of opts.t0Events) {
        insT0.run(
          t0.event_id,
          t0.ts,
          t0.event_type,
          t0.provider,
          t0.model,
          t0.cost_usd,
          t0.payload_json,
        );
      }
    }
  } finally {
    db.close();
  }
}

function seedCopyDir(
  prefix: string,
  rows: SeedRows,
  opts: { t0Events?: T0EventRow[] } = {},
): string {
  const dir = mkTmp(prefix);
  const dbPath = join(dir, "copy.sqlite");
  seedDb(dbPath, rows, opts);
  return dbPath;
}

function ingestArgv(dbPath: string, t0RetentionDays = "30"): string[] {
  return [
    "ingest",
    "--db",
    dbPath,
    "--retention-days",
    "30",
    "--t0-retention-days",
    t0RetentionDays,
  ];
}

function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function lineageLine(stdout: string, rootHandoffId: string): Record<string, unknown> {
  const line = jsonLines(stdout).find(
    (candidate) =>
      candidate["type"] === "lineage" && candidate["root_handoff_id"] === rootHandoffId,
  );
  expect(line).not.toBeUndefined();
  return line!;
}

// --- holdout store / plan helpers (shape copied from holdout-store.test.ts) ---

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

function mkPlanRepo(): { planPath: string } {
  const repoRoot = mkTmp("penumbra-eval-plan-");
  gitSync(repoRoot, ["init", "-q"]);
  const planPath = join(repoRoot, "plan.json");
  writeFileSync(planPath, '{"max_unseals":3}\n', "utf8");
  gitSync(repoRoot, ["add", "plan.json"]);
  gitSync(repoRoot, [...COMMIT_IDENTITY, "commit", "-q", "-m", "plan"]);
  return { planPath };
}

// --- import-graph walk ---------------------------------------------------------

function walkNonTestTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkNonTestTs(path));
    } else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

function extractSpecifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        out.push(specifier);
      }
    }
  }
  return out;
}

// --- observational episode (shape copied from verify.test.ts makeEpisode) -------

function modelIdentityField(): Record<string, unknown> {
  return { value: null, provenance: "unknown", missing_reason: "x" };
}

function modelIdentity(): Record<string, unknown> {
  return {
    requested: modelIdentityField(),
    effective: modelIdentityField(),
    quant: modelIdentityField(),
    engine: modelIdentityField(),
    adapter: modelIdentityField(),
    config_sha256: null,
    artifact_identity: null,
  };
}

function observationalEpisode(): Record<string, unknown> {
  const sha = "c".repeat(40);
  return {
    schema_version: 1,
    episode_id: "e-obs-1",
    family_id: "fam-obs",
    fixture_ref: null,
    split: "dev",
    design: "observational",
    failure_type: null,
    task_digest: null,
    task_refs: { issues: [], bundle_ids: [] },
    repo: { base_sha: "a".repeat(40), dependency_lock_sha256: null },
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
    attempts: [
      {
        n: 1,
        handoff_id: "h1",
        dispatch_attempt: null,
        head_sha: sha,
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
      },
    ],
    assistance: [],
    final_sha: sha,
    receipts: [],
    observed_outcome: { class: "terminal_unverified" },
    handoff_reliability: null,
    lineage_usage: null,
    labels: {},
  };
}

// --- cases ---------------------------------------------------------------------

test("runCli refuses every live-trial argv with the blocked message", async () => {
  const mod = run();
  expect(mod.BLOCKED_MESSAGE).toBe("BLOCKED: live trials require a separately authorized stage");
  for (const argv of [
    ["--live"],
    ["replay", "--live"],
    ["executor"],
    ["codex"],
    ["live"],
    ["import-real"],
    ["replay", "--agent", "claude"],
    ["replay", "--executor", "x"],
  ]) {
    const res = await mod.runCli(argv);
    expect(res.code).toBe(2);
    expect(res.stderr).toBe(`${mod.BLOCKED_MESSAGE}\n`);
    expect(res.stdout).toBe("");
  }
});

test("run.ts refuses --live when spawned as a script", () => {
  expect(existsSync(RUN_PATH)).toBe(true);
  const res = spawnSync(process.execPath, [RUN_PATH, "--live"], { encoding: "utf8" });
  expect(res.status).toBe(2);
  expect(res.stderr).toContain("BLOCKED: live trials require a separately authorized stage");
});

const FORBIDDEN_SPECIFIERS = ["plugin/", "adapters/registry", "bench-fleet", "penumbra-client"];

function fileViolations(file: string, text: string): string[] {
  const violations: string[] = [];
  for (const specifier of extractSpecifiers(text)) {
    for (const bad of FORBIDDEN_SPECIFIERS) {
      if (specifier.includes(bad)) {
        violations.push(`${file}: import specifier ${specifier}`);
      }
    }
  }
  if (text.includes("PenumbraClient")) {
    violations.push(`${file}: PenumbraClient`);
  }
  if (text.includes("runBench")) {
    violations.push(`${file}: runBench`);
  }
  if (/(?:^|[^.\w])fetch\s*\(/m.test(text)) {
    violations.push(`${file}: global fetch(`);
  }
  return violations;
}

test("evals modules never reach live penumbra surfaces", () => {
  const evalsDir = fileURLToPath(new URL(".", import.meta.url));
  for (const name of ["run.ts", "ingest-db.ts", "report.ts", "bench-adapter.ts"]) {
    expect(existsSync(join(evalsDir, name))).toBe(true);
  }
  const files = walkNonTestTs(evalsDir);
  expect(files.length).toBeGreaterThan(0);
  const violations = files.flatMap((file) => fileViolations(file, readFileSync(file, "utf8")));
  expect(violations).toEqual([]);
});

test("ingest refuses the live storage db path, including through a symlink", async () => {
  const mod = run();
  const storageRoot = mkTmp("penumbra-eval-live-");
  const liveDb = join(storageRoot, "db.sqlite");
  seedDb(liveDb, readSeedRows());
  const deps = gradingDeps(storageRoot);

  const direct = await mod.runCli(ingestArgv(liveDb), deps);
  expect(direct.code).toBe(2);
  expect(direct.stderr.startsWith("db_is_live_storage")).toBe(true);

  const linkDir = mkTmp("penumbra-eval-link-");
  const linkPath = join(linkDir, "linked.sqlite");
  symlinkSync(liveDb, linkPath);
  const viaLink = await mod.runCli(ingestArgv(linkPath), deps);
  expect(viaLink.code).toBe(2);
  expect(viaLink.stderr.startsWith("db_is_live_storage")).toBe(true);
});

test("ingest reports absent t0 usage without touching the db copy", async () => {
  const mod = run();
  const copyPath = seedCopyDir("penumbra-eval-dbcopy-", readSeedRows());
  const before = sha256Hex(readFileSync(copyPath));
  const res = await mod.runCli(ingestArgv(copyPath), gradingDeps(mkTmp("penumbra-eval-storage-")));
  expect(res.code).toBe(0);
  expect(sha256Hex(readFileSync(copyPath))).toBe(before);
  const line = lineageLine(res.stdout, "h-103");
  expect(line["lineage_usage"]).toBeNull();
  expect(line["usage_missing_reason"]).toBe("t0_events_absent");
});

test("ingest requires both retention flags", async () => {
  const mod = run();
  const copyPath = seedCopyDir("penumbra-eval-dbcopy-", readSeedRows());
  const deps = gradingDeps(mkTmp("penumbra-eval-storage-"));

  const missingT0 = await mod.runCli(["ingest", "--db", copyPath, "--retention-days", "30"], deps);
  expect(missingT0.code).toBe(2);
  expect(missingT0.stderr.startsWith("retention_flags_required")).toBe(true);

  const missingRetention = await mod.runCli(
    ["ingest", "--db", copyPath, "--t0-retention-days", "30"],
    deps,
  );
  expect(missingRetention.code).toBe(2);
  expect(missingRetention.stderr.startsWith("retention_flags_required")).toBe(true);
});

test("ingest sums t0 usage rows into lineage_usage", async () => {
  const mod = run();
  const copyPath = seedCopyDir("penumbra-eval-dbcopy-", readSeedRows(), {
    t0Events: [T0_USAGE_ROW],
  });
  const res = await mod.runCli(ingestArgv(copyPath), gradingDeps(mkTmp("penumbra-eval-storage-")));
  expect(res.code).toBe(0);
  const line = lineageLine(res.stdout, "h-103");
  expect(line["lineage_usage"]).toEqual({
    tokens: 1234,
    cost_usd: 0.5,
    handoff_ids_counted: 1,
    complete: true,
    incomplete_reason: null,
  });
});

test("ingest marks lineage usage incomplete outside the t0 retention window", async () => {
  const mod = run();
  const copyPath = seedCopyDir("penumbra-eval-dbcopy-", readSeedRows(), {
    t0Events: [T0_USAGE_ROW],
  });
  const res = await mod.runCli(
    ingestArgv(copyPath, "1"),
    gradingDeps(mkTmp("penumbra-eval-storage-")),
  );
  expect(res.code).toBe(0);
  const line = lineageLine(res.stdout, "h-103");
  expect(line["lineage_usage"]).toMatchObject({
    complete: false,
    incomplete_reason: "t0_retention_window",
  });
});

test("ingest rejects rows that fail the strict ingest schema", async () => {
  const mod = run();
  const rows = readSeedRows();
  const first = rows.events[0];
  expect(first).not.toBeUndefined();
  first!.kind = "bogus.kind";
  const copyPath = seedCopyDir("penumbra-eval-dbcopy-", rows);
  const res = await mod.runCli(ingestArgv(copyPath), gradingDeps(mkTmp("penumbra-eval-storage-")));
  expect(res.code).toBe(1);
  expect(res.stderr.startsWith("ingest_rows_invalid")).toBe(true);
});

test("compare refuses observational episodes", async () => {
  const mod = run();
  const episode = observationalEpisode();
  expect(EpisodeSchema.safeParse(episode).success).toBe(true);
  const episodesPath = join(mkTmp("penumbra-eval-eps-"), "episodes.jsonl");
  writeFileSync(episodesPath, `${JSON.stringify(episode)}\n`, "utf8");
  const res = await mod.runCli(
    [
      "compare",
      "--episodes",
      episodesPath,
      "--baseline",
      "minimal",
      "--treatment",
      "capsule",
      "--seed",
      "1",
    ],
    gradingDeps(mkTmp("penumbra-eval-storage-")),
  );
  expect(res.code).toBe(2);
  const first = res.stdout.split("\n").find((line) => line.trim() !== "");
  expect(first).not.toBeUndefined();
  expect(JSON.parse(first!) as unknown).toMatchObject({
    status: "refused",
    reason: "observational_comparison",
  });
});

test("resolveHarnessBuild gates the autocommit flag ancestry", async () => {
  const mod = run();
  expect(mod.AUTOCOMMIT_FLAG_SHA).toBe("06cfcc9acc77cbc0d3650d50c6af1294e702d21b");
  const sha = "b".repeat(40);
  const calls: [string, string][] = [];
  const yes = (ancestor: string, descendant: string): Promise<boolean> => {
    calls.push([ancestor, descendant]);
    return Promise.resolve(true);
  };

  const ok = await mod.resolveHarnessBuild({ design: "controlled", buildSha: sha }, yes);
  expect(ok).toEqual({ sha });
  expect(calls).toEqual([[mod.AUTOCOMMIT_FLAG_SHA, sha]]);

  const predates = await mod.resolveHarnessBuild({ design: "controlled", buildSha: sha }, () =>
    Promise.resolve(false),
  );
  expect(predates).toEqual({
    sha: null,
    missing_reason: "build_predates_autocommit_flag",
  });

  const observational = await mod.resolveHarnessBuild(
    { design: "observational", buildSha: sha },
    yes,
  );
  expect(observational).toMatchObject({ sha: null });

  const unknownSha = await mod.resolveHarnessBuild({ design: "controlled", buildSha: null }, yes);
  expect(unknownSha).toEqual({ sha: null, missing_reason: "build_sha_unknown" });
});

test("replay with a non-synthetic lock entry requires an unseal", async () => {
  const mod = run();
  const store = mkTmp("penumbra-eval-store-");
  const root = { kind: "issue", number: 424242 } as const;
  const bundle = mkBundle(familyIdForRoot(root), "v1", 1);
  const entry: HoldoutLockEntry = {
    family_id: familyIdForRoot(root),
    variant_id: "v1",
    root,
    failure_type: "missed_commit",
    synthetic: false,
    expect_blocked: false,
    base_sha: "a".repeat(40),
    task_digest: "b".repeat(64),
    source_root_handoff_digests: [],
    content_digest: bundleContentDigest(bundle),
    assertion_set_digest: assertionSetDigest(bundle),
  };
  const lock: HoldoutLock = {
    schema_version: 1,
    entries: [entry],
    digest: computeLockDigest([entry]),
  };
  const lockPath = join(mkTmp("penumbra-eval-lock-"), "lock.json");
  writeFileSync(lockPath, JSON.stringify(lock), "utf8");

  const res = await mod.runCli(
    ["replay", "--corpus", DEFAULT_CORPUS_ROOT, "--holdout-store", store, "--lock", lockPath],
    gradingDeps(mkTmp("penumbra-eval-storage-")),
  );
  expect(res.code).toBe(2);
  expect(res.stderr.startsWith("unseal_required")).toBe(true);
  expect(existsSync(join(store, "access.jsonl"))).toBe(false);
});

test("one runCli opens the holdout store once and consumes a single unseal", async () => {
  const mod = run();
  const scratch = await openGraderScratch({ sourceRepo: null });
  scratches.push(scratch);
  const fixtures = await lintCorpus(DEFAULT_CORPUS_ROOT, { scratch });
  const entry = fixtures.find((fixture) => fixture.dir === "synthetic/syn-contract-validator");
  expect(entry).not.toBeUndefined();
  const fixture = entry!.fixture;
  const bundle = entry!.bundle;
  expect(bundle).not.toBeNull();

  const store = mkTmp("penumbra-eval-store-");
  const bundleDir = join(store, bundleContentDigest(bundle!));
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "bundle.json"), JSON.stringify(bundle), "utf8");

  const lockEntry: HoldoutLockEntry = {
    family_id: fixture.family_id,
    variant_id: fixture.variant_id,
    root: fixture.root,
    failure_type: fixture.failure_type,
    synthetic: true,
    expect_blocked: fixture.expect_blocked,
    base_sha: fixture.base_sha,
    task_digest: fixture.task_digest,
    source_root_handoff_digests: fixture.source_root_handoff_digests,
    content_digest: fixture.content_digest,
    assertion_set_digest: fixture.hidden_ref.assertion_set_digest,
  };
  const lock: HoldoutLock = {
    schema_version: 1,
    entries: [lockEntry],
    digest: computeLockDigest([lockEntry]),
  };
  const lockPath = join(mkTmp("penumbra-eval-lock-"), "lock.json");
  writeFileSync(lockPath, JSON.stringify(lock), "utf8");
  const { planPath } = mkPlanRepo();

  const res = await mod.runCli(
    [
      "replay",
      "--corpus",
      DEFAULT_CORPUS_ROOT,
      "--only",
      "synthetic/syn-contract-validator",
      "--holdout-store",
      store,
      "--lock",
      lockPath,
      "--unseal",
      planPath,
      "grade",
      "verify",
    ],
    gradingDeps(mkTmp("penumbra-eval-storage-")),
  );
  expect(res.code).toBe(0);

  const accessPath = join(store, "access.jsonl");
  expect(existsSync(accessPath)).toBe(true);
  const lines = readFileSync(accessPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  expect(lines).toHaveLength(1);
  expect((JSON.parse(lines[0]!) as Record<string, unknown>)["granted"]).toBe(true);
}, 300_000);

// --- verify-stage / error-mapping pins (#391 P14 review) ------------------------

function verifyOf(episode: Record<string, unknown>): Record<string, unknown> {
  const verify: unknown = episode["verify"];
  return typeof verify === "object" && verify !== null ? (verify as Record<string, unknown>) : {};
}

test("verify stage alone populates the report without aggregate", async () => {
  const mod = run();
  const res = await mod.runCli(
    [
      "replay",
      "--corpus",
      DEFAULT_CORPUS_ROOT,
      "--only",
      "synthetic/syn-missed-commit",
      "grade",
      "verify",
      "report",
    ],
    gradingDeps(mkTmp("penumbra-eval-storage-")),
  );
  expect(res.code).toBe(0);
  const episodes = jsonLines(res.stdout).filter((line) => line["type"] === "episode");
  expect(episodes.length).toBeGreaterThanOrEqual(1);
  expect(
    episodes.some(
      (episode) =>
        verifyOf(episode)["status"] === "verified" && verifyOf(episode)["verdict"] === "pass",
    ),
  ).toBe(true);
  expect(episodes.every((episode) => verifyOf(episode)["status"] !== "pending")).toBe(true);
}, 300_000);

test("ingest opens the sqlite handle read-only", () => {
  const copyPath = seedCopyDir("penumbra-eval-dbcopy-", readSeedRows());
  const db = openIngestDatabase(copyPath);
  try {
    expect(() => {
      db.run(
        "INSERT INTO handoffs(handoff_id, ts, message) VALUES ('x', '2026-06-20T00:00:00Z', 'x')",
      );
    }).toThrow();
  } finally {
    db.close();
  }
});

test("replay with a nonexistent --lock returns exit 2 lock_invalid without throwing", async () => {
  const mod = run();
  const missingPath = join(mkTmp("penumbra-eval-lock-"), "missing-lock.json");
  const res = await mod.runCli(
    ["replay", "--lock", missingPath],
    gradingDeps(mkTmp("penumbra-eval-storage-")),
  );
  expect(res.code).toBe(2);
  expect(res.stderr.startsWith("lock_invalid")).toBe(true);
  expect(res.stdout).toBe("");
});

test("an invalid --unseal plan returns exit 2 unseal_invalid without throwing", async () => {
  const mod = run();
  const lock: HoldoutLock = { schema_version: 1, entries: [], digest: computeLockDigest([]) };
  const lockPath = join(mkTmp("penumbra-eval-lock-"), "lock.json");
  writeFileSync(lockPath, JSON.stringify(lock), "utf8");
  const planPath = join(mkTmp("penumbra-eval-plan-"), "plan.json");
  writeFileSync(planPath, '{"max_unseals":0}\n', "utf8");
  const res = await mod.runCli(
    ["replay", "--lock", lockPath, "--unseal", planPath],
    gradingDeps(mkTmp("penumbra-eval-storage-")),
  );
  expect(res.code).toBe(2);
  expect(res.stderr.startsWith("unseal_invalid")).toBe(true);
  expect(res.stdout).toBe("");
});

test("replay --unseal without --lock returns exit 2 unseal_invalid", async () => {
  const mod = run();
  const planPath = join(mkTmp("penumbra-eval-plan-"), "plan.json");
  writeFileSync(planPath, '{"max_unseals":3}\n', "utf8");
  const res = await mod.runCli(
    ["replay", "--unseal", planPath],
    gradingDeps(mkTmp("penumbra-eval-storage-")),
  );
  expect(res.code).toBe(2);
  expect(res.stderr.startsWith("unseal_invalid")).toBe(true);
  expect(res.stdout).toBe("");
});

test("conflicting store flags across stages return exit 2 store_flags_conflict", async () => {
  const mod = run();
  const dir = mkTmp("penumbra-eval-conflict-");
  for (const flag of ["--lock", "--unseal", "--holdout-store"]) {
    const res = await mod.runCli(
      ["replay", flag, join(dir, "first"), "grade", flag, join(dir, "second")],
      gradingDeps(mkTmp("penumbra-eval-storage-")),
    );
    expect(res.code).toBe(2);
    expect(res.stderr.startsWith(`store_flags_conflict ${flag}`)).toBe(true);
    expect(res.stdout).toBe("");
  }
});

test("the ingest call site opens the handle read-only through the public path", async () => {
  const mod = run();
  const missingPath = join(mkTmp("penumbra-eval-rocall-"), "absent.sqlite");
  const res = await mod.runCli(
    ingestArgv(missingPath),
    gradingDeps(mkTmp("penumbra-eval-storage-")),
  );
  // A read-write handle would create the missing file and fail downstream with
  // "ingest_failed no such table"; a readonly handle rejects the open itself
  // (chmod cannot pin this: sqlite downgrades rw opens on unwritable files).
  expect(existsSync(missingPath)).toBe(false);
  expect(res.code).toBe(1);
  expect(res.stderr.startsWith("ingest_failed")).toBe(false);
  expect(res.stderr).not.toBe("");
});
