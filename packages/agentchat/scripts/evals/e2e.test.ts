import { Database } from "bun:sqlite";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DependencyProvider } from "./grader/deps.js";
import type { SandboxKind } from "./grader/sandbox.js";
import type { GraderAllowlist } from "./grader/verify.js";

import { DEFAULT_CORPUS_ROOT } from "./corpus.js";

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
}

const RUN_URL = new URL("./run.ts", import.meta.url).href;

let runMod: RunModule | null = null;

beforeAll(async () => {
  runMod = (await import(RUN_URL).catch(() => null)) as RunModule | null;
});

function run(): RunModule {
  expect(runMod).not.toBeNull();
  return runMod!;
}

// --- seeded sqlite copy (helpers duplicated from run.test.ts per dispatch) ----

const NOW_MS = Date.parse("2026-06-20T00:00:00Z");
const BUILD_ID = "a".repeat(64);

const tempDirs: string[] = [];

afterEach(() => {
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

interface SeedRows {
  handoffs: SeedHandoffRow[];
  events: SeedEventRow[];
  retry_events?: { event_id: string; handoff_id: string }[];
  lanes?: {
    lane_id: string;
    implementer_handoff: string;
    gate_status: string;
    ts_closed: string | null;
  }[];
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

// --- report assertions ---------------------------------------------------------

function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function replayPatchOf(episode: Record<string, unknown>): unknown {
  const direct = episode["replay_patch"];
  if (typeof direct === "string") {
    return direct;
  }
  const labels = episode["labels"];
  if (typeof labels === "object" && labels !== null) {
    return (labels as Record<string, unknown>)["replay_patch"];
  }
  return undefined;
}

function verifyOutcome(episode: Record<string, unknown>): Record<string, unknown> {
  const verify: unknown = episode["verify"];
  return typeof verify === "object" && verify !== null ? (verify as Record<string, unknown>) : {};
}

function numericField(container: unknown, key: string): number {
  if (typeof container !== "object" || container === null) {
    return 0;
  }
  const value = (container as Record<string, unknown>)[key];
  return typeof value === "number" ? value : 0;
}

test("offline eval pipeline produces the golden report deterministically", async () => {
  const mod = run();
  const goldenPath = fileURLToPath(new URL("./golden/report.jsonl", import.meta.url));
  const goldenBytes = await readFile(goldenPath).catch(() => null);
  expect(goldenBytes).not.toBeNull();

  const dbDir = mkTmp("penumbra-e2e-db-");
  const copyPath = join(dbDir, "copy.sqlite");
  seedDb(copyPath, readSeedRows(), { t0Events: [T0_USAGE_ROW] });

  const outDir = mkTmp("penumbra-e2e-out-");
  const outPath = join(outDir, "report.jsonl");
  const deps = gradingDeps(mkTmp("penumbra-e2e-storage-"));
  const argv = [
    "ingest",
    "--db",
    copyPath,
    "--retention-days",
    "30",
    "--t0-retention-days",
    "30",
    "replay",
    "--corpus",
    DEFAULT_CORPUS_ROOT,
    "--only",
    "synthetic/syn-contract-validator,synthetic/syn-missed-commit",
    "grade",
    "verify",
    "aggregate",
    "--seed",
    "7",
    "report",
    "--out",
    outPath,
  ];

  const res = await mod.runCli(argv, deps);
  expect(res.code).toBe(0);

  const outBytes = readFileSync(outPath);
  expect(outBytes.equals(goldenBytes!)).toBe(true);

  const lines = jsonLines(outBytes.toString("utf8"));
  const runLine = lines.find((line) => line["type"] === "run");
  expect(runLine).toMatchObject({ seed: 7, holdout: "none", underpowered: true });
  expect(runLine?.["stages"]).toContain("replay");

  let solvedS = 0;
  let solvedN = 0;
  let hiddenFailed = 0;
  for (const line of lines.filter((candidate) => candidate["type"] === "aggregate")) {
    solvedS += numericField(line["solved_verified"], "s");
    solvedN += numericField(line["solved_verified"], "n");
    hiddenFailed += numericField(line["failures"], "hidden_failed");
  }
  expect(solvedS).toBeGreaterThanOrEqual(1);
  expect(solvedN).toBeGreaterThanOrEqual(2);
  expect(hiddenFailed).toBeGreaterThanOrEqual(1);

  const episodes = lines.filter((line) => line["type"] === "episode");
  const hasVerified = (episode: Record<string, unknown>, verdict: string): boolean => {
    const outcome = verifyOutcome(episode);
    return outcome.status === "verified" && outcome.verdict === verdict;
  };
  expect(
    episodes.some((episode) => {
      const patch = replayPatchOf(episode);
      return typeof patch === "string" && patch.startsWith("bad-") && hasVerified(episode, "fail");
    }),
  ).toBe(true);
  expect(episodes.some((episode) => hasVerified(episode, "pass"))).toBe(true);

  const outText = outBytes.toString("utf8");
  expect(outText).not.toContain(tmpdir());
  expect(outText).not.toContain(deps.storageRoot);

  const outPath2 = join(outDir, "report-2.jsonl");
  const res2 = await mod.runCli([...argv.slice(0, -1), outPath2], deps);
  expect(res2.code).toBe(0);
  expect(readFileSync(outPath2).equals(outBytes)).toBe(true);
}, 600_000);
