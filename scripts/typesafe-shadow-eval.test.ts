import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  TypesafeFetch,
  TypesafeSettings,
} from "../packages/integrations/typesafe/src/index.js";

import { applySchema, loadSqliteVec } from "../packages/core/src/index.js";
import {
  PROMOTION_PINNED_MODEL_ID,
  PROMOTION_QUESTION_IDS,
} from "../packages/integrations/typesafe/src/questions/promotion.js";
import {
  DEFAULT_DEGRADED_WINDOW,
  incumbentFromBallots,
  openReplayDb,
  parseShadowEvalArgs,
  runShadowEval,
} from "./typesafe-shadow-eval.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

const TEST_SETTINGS: TypesafeSettings = {
  enabled: true,
  apiKey: "test-key",
  keySource: "env",
  baseUrl: "https://api.typesafe.ai",
  model: "jev-1.13.0",
  timeoutMs: 10000,
  judgePromotion: "shadow",
};

const EXCERPT_R1 =
  "The reconciler baseline worktree has no node_modules, so `tests: fail` was a false land-gate block.";
const EXCERPT_R2 =
  "The claim-spread sweeper reoffered handoff h_9137 after the assigned seat went dark mid-dispatch.";
const EXCERPT_R3 = "0123456789abcdef0123456789abcd";
const EXCERPT_R4 =
  "Seat 2 abstained on every promote_t1 ballot for this rollup and no verdict row was ever written.";
const EXCERPT_R5 =
  "Session-scoped note: the bench fleet ran twice on 2026-09-05 and the second run was a retry.";

const R1_VOTES = [
  { promote: true, confidence: 0.9 },
  { promote: true, confidence: 0.8 },
  { promote: false, confidence: 0.99 },
];
const R2_VOTES = [
  { promote: true, confidence: 0.9 },
  { promote: true, confidence: 0.85 },
];
const R5_VOTES = [
  { promote: false, confidence: 1 },
  { promote: false, confidence: 0, abstained: true },
  { promote: false, confidence: 0.95 },
];

const tempDirs: string[] = [];

afterEach((): void => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function insertRollup(db: Database, rollupId: string, excerpt: string): void {
  db.prepare(
    `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events, first_prompt_excerpt)
     VALUES(?, 'test-user', ?, '2026-09-01T00:00:00Z', 1, ?)`,
  ).run(rollupId, `session-${rollupId}`, excerpt);
}

function insertCycle(db: Database, cycleId: string, startedAtIso: string): void {
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome)
     VALUES(?, ?, 'cron', 1.0, 'completed')`,
  ).run(cycleId, Date.parse(startedAtIso));
}

function insertAction(
  db: Database,
  actionId: string,
  cycleId: string,
  rollupId: string,
  confidence: number,
  votes: readonly unknown[],
): void {
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
     VALUES(?, ?, 'P1', 'promote_t1', ?, 'queued', ?, ?)`,
  ).run(actionId, cycleId, confidence, JSON.stringify([rollupId]), JSON.stringify({ votes }));
}

function makeSeededDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "typesafe-shadow-eval-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "db.sqlite");
  const db = new Database(dbPath);
  try {
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 3 });
    insertRollup(db, "R1", EXCERPT_R1);
    insertRollup(db, "R2", EXCERPT_R2);
    insertRollup(db, "R3", EXCERPT_R3);
    insertRollup(db, "R4", EXCERPT_R4);
    insertRollup(db, "R5", EXCERPT_R5);
    insertCycle(db, "C1", "2026-09-05T10:00:00.000Z");
    insertCycle(db, "C2", "2026-09-14T10:00:00.000Z");
    insertCycle(db, "C3", "2026-09-05T12:00:00.000Z");
    insertAction(db, "A1", "C1", "R1", 0.97, R1_VOTES);
    insertAction(db, "A2", "C2", "R2", 0.9, R2_VOTES);
    insertAction(db, "A5", "C3", "R5", 0.5, R5_VOTES);
  } finally {
    db.close();
  }
  return { dir, dbPath };
}

interface RecordedFetchCall {
  url: string;
  body: Record<string, unknown>;
}

function wireAnswers(nouls: readonly number[]): Record<string, { type: "noul"; noul: number }> {
  const answers: Record<string, { type: "noul"; noul: number }> = {};
  for (const [index, id] of PROMOTION_QUESTION_IDS.entries()) {
    answers[id] = { type: "noul", noul: nouls[index] ?? 0 };
  }
  return answers;
}

function noulsFor(body: string): readonly number[] {
  if (body === EXCERPT_R1) return [0.9, 0.1, 0.1, 0.1];
  if (body === EXCERPT_R5) return [0.1, 0.1, 0.1, 0.1];
  return [0.5, 0.5, 0.5, 0.5];
}

function recordingFetch(calls: RecordedFetchCall[]): TypesafeFetch {
  return (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    const state = body["state"] as { body?: unknown } | undefined;
    const nouls = noulsFor(typeof state?.body === "string" ? state.body : "");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          model: PROMOTION_PINNED_MODEL_ID,
          answers: wireAnswers(nouls),
          usage: { input_tokens: 312, output_tokens: 48 },
        }),
        { status: 200 },
      ),
    );
  };
}

function readRows(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("parseShadowEvalArgs applies the documented defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-eval-root-"));
  tempDirs.push(dir);
  const previous = process.env.PENUMBRA_STORAGE_ROOT;
  process.env.PENUMBRA_STORAGE_ROOT = dir;
  try {
    const args = parseShadowEvalArgs(["--out", "x.jsonl"]);
    expect(args.limit).toBe(50);
    expect(args.live).toBe(false);
    expect(args.degradedWindow).toEqual(DEFAULT_DEGRADED_WINDOW);
    expect(args.dbPath.endsWith("db.sqlite")).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.PENUMBRA_STORAGE_ROOT;
    else process.env.PENUMBRA_STORAGE_ROOT = previous;
  }
});

test("incumbentFromBallots derives the verdict from ballots, never the stored confidence", () => {
  const r1 = incumbentFromBallots({ ballots: R1_VOTES, storedConfidence: 0.97 });
  expect(r1.pYes).toBeCloseTo(2 / 3);
  expect(r1.decision).toBe("promote");

  const r5 = incumbentFromBallots({ ballots: R5_VOTES, storedConfidence: 0.5 });
  expect(r5.pYes).toBe(0);
  expect(r5.decision).toBe("no_promote");

  const short = incumbentFromBallots({
    ballots: [{ promote: true }, { abstained: true }],
    storedConfidence: 0.99,
  });
  expect(short.decision).toBe("insufficient");
});

test("openReplayDb opens the file read-only", () => {
  const { dbPath } = makeSeededDb();
  const db = openReplayDb(dbPath);
  try {
    expect(() => db.run("CREATE TABLE t(x)")).toThrow();
  } finally {
    db.close();
  }
});

test("incumbent-only replay writes labelled rows and makes no network calls", async () => {
  const { dir, dbPath } = makeSeededDb();
  const outPath = join(dir, "rows.jsonl");
  const calls: RecordedFetchCall[] = [];
  const summary = await runShadowEval(parseShadowEvalArgs(["--db", dbPath, "--out", outPath]), {
    fetch: recordingFetch(calls),
  });
  expect(calls).toHaveLength(0);

  const rows = readRows(outPath);
  expect(rows.map((row) => row["rollup_id"]).sort()).toEqual(["R1", "R5"]);
  for (const row of rows) {
    expect(row["jev_answers"]).toBeNull();
  }

  expect(summary.total_eligible).toBe(4);
  expect(summary.unlabelled).toBe(1);
  expect(summary.excluded_degraded).toBe(1);
  expect(summary.judged).toBe(2);
  expect(summary.jev_answered).toBe(0);
  expect(summary.agreementRate).toBeNull();
});

test("live replay judges each labelled row through the pinned systemone endpoint", async () => {
  const { dir, dbPath } = makeSeededDb();
  const outPath = join(dir, "rows.jsonl");
  const calls: RecordedFetchCall[] = [];
  const summary = await runShadowEval(
    parseShadowEvalArgs(["--db", dbPath, "--out", outPath, "--live"]),
    { fetch: recordingFetch(calls), settings: TEST_SETTINGS },
  );

  expect(calls).toHaveLength(2);
  const stateBodies: string[] = [];
  for (const call of calls) {
    expect(call.url.endsWith("/v1/systemone")).toBe(true);
    expect(call.url).not.toContain("chat/completions");
    expect(call.body["model"]).toBe(PROMOTION_PINNED_MODEL_ID);
    const state = call.body["state"] as { kind: string; body: string };
    expect(Object.keys(state).sort()).toEqual(["body", "kind"]);
    expect(state.kind).toBe("promote_t1");
    stateBodies.push(state.body);
  }
  expect(stateBodies.sort()).toEqual([EXCERPT_R1, EXCERPT_R5].sort());

  const rows = readRows(outPath);
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(Object.keys(row)).toEqual([
      "rollup_id",
      "incumbent_ballots",
      "incumbent_decision",
      "jev_answers",
      "model",
      "usage",
    ]);
    expect(Object.keys(row["usage"] as Record<string, unknown>)).toEqual([
      "inputTokens",
      "outputTokens",
    ]);
  }
  expect(summary.jev_answered).toBe(2);
});

test("the summary carries the per-class confusion matrix", async () => {
  const { dir, dbPath } = makeSeededDb();
  const outPath = join(dir, "rows.jsonl");
  const calls: RecordedFetchCall[] = [];
  const summary = await runShadowEval(
    parseShadowEvalArgs(["--db", dbPath, "--out", outPath, "--live"]),
    { fetch: recordingFetch(calls), settings: TEST_SETTINGS },
  );

  expect(summary.confusion).toEqual({
    both_promote: 1,
    incumbent_only: 0,
    jev_only: 0,
    neither: 1,
  });
  expect(summary.agreedCount).toBe(2);
  expect(summary.disagreedCount).toBe(0);
  expect(summary.agreementRate).toBe(1);
  expect(summary.jev_failed).toBe(0);
  expect(summary.incumbent_insufficient).toBe(0);
  expect(summary.p_gap_mean).toBeCloseTo(0.1167, 4);
  expect(summary.total_input_tokens).toBe(624);
  expect(summary.total_usd).toBeGreaterThan(0);
});

test("moving the degraded window brings in-window judgements back", async () => {
  const { dir, dbPath } = makeSeededDb();
  const outPath = join(dir, "rows.jsonl");
  const calls: RecordedFetchCall[] = [];
  const summary = await runShadowEval(
    parseShadowEvalArgs([
      "--db",
      dbPath,
      "--out",
      outPath,
      "--degraded-from",
      "2026-01-01T00:00:00Z",
      "--degraded-to",
      "2026-01-02T00:00:00Z",
    ]),
    { fetch: recordingFetch(calls) },
  );

  const rows = readRows(outPath);
  expect(rows).toHaveLength(3);
  expect(summary.excluded_degraded).toBe(0);
  expect(summary.judged).toBe(3);
  expect(calls).toHaveLength(0);
});
