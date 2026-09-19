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
import { KNOWN_LONG_LIVED_DISPATCHER_USER_IDS } from "../packages/daemon/src/dreaming/cycle.js";
import {
  PROMOTION_PINNED_MODEL_ID,
  PROMOTION_QUESTION_IDS,
  PROMOTION_QUESTIONS,
  promotionUsdForInputTokens,
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
const EXCERPT_R6 =
  "The dream_actions row for this rollup references a cycle row that no longer exists in dream_cycles.";
const EXCERPT_R7 =
  "A judgement emitted at the exact start of the degraded window is still inside the window.";
const EXCERPT_R8 =
  "A judgement emitted at the exact end of the degraded window is already outside the window.";
const EXCERPT_R9 =
  "Only one seat ever returned a ballot for this rollup, so the incumbent quorum floor was not met.";
const EXCERPT_R10 =
  "The worktree-gc sweeper tore down three lanes whose handoffs had been terminal for over two hours.";
const EXCERPT_R11_BODY = `durable finding: ${"x".repeat(17000)}`;
const EXCERPT_R12 =
  "One promote_t1 judgement row lost its cycle join while a sibling landed inside the degraded window.";
const EXCERPT_R13 =
  "You are home-mgmt, a long-lived agent running custodial checks over the fleet.";
const EXCERPT_R14 =
  "The dispatcher seat wrote this durable finding about queue replays during the incident.";
const EXCERPT_R15 =
  "An ordinary rollup whose first prompt was a normal user question about caching.";

const MIXED_BALLOTS = [
  { promote: "yes", confidence: 0.9 },
  { promote: null },
  { confidence: 0.7 },
  { promote: true, seat: "seat-1" },
  { promote: false },
];

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

function insertRollup(db: Database, rollupId: string, excerpt: string, userId = "test-user"): void {
  db.prepare(
    `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events, first_prompt_excerpt)
     VALUES(?, ?, ?, '2026-09-01T00:00:00Z', 1, ?)`,
  ).run(rollupId, userId, `session-${rollupId}`, excerpt);
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

// The cap-estimate contract under test: the excerpt plus the fixed question
// envelope at 3 characters per token, priced at the pinned model's input rate.
const REQUEST_OVERHEAD_CHARS = JSON.stringify({
  state: { kind: "promote_t1", body: "" },
  model: PROMOTION_PINNED_MODEL_ID,
  questions: PROMOTION_QUESTIONS,
}).length;

function liveInputTokens(body: string): number {
  return Math.ceil((body.length + REQUEST_OVERHEAD_CHARS) / 3);
}

function liveRequestUsd(body: string): number {
  return promotionUsdForInputTokens(liveInputTokens(body));
}

function estimateBillingFetch(calls: RecordedFetchCall[]): TypesafeFetch {
  return (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    const state = body["state"] as { body?: unknown } | undefined;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          model: PROMOTION_PINNED_MODEL_ID,
          answers: wireAnswers([0.9, 0.1, 0.1, 0.1]),
          usage: {
            input_tokens: liveInputTokens(typeof state?.body === "string" ? state.body : ""),
            output_tokens: 48,
          },
        }),
        { status: 200 },
      ),
    );
  };
}

// bun:test's `.rejects.toThrow()` is typed as void even though it awaits the
// underlying promise at runtime. Use this helper instead.
async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
    expect(String(err)).toMatch(pattern);
  }
  expect(threw).toBe(true);
}

function mutateDb(dbPath: string, fn: (db: Database) => void): void {
  const db = new Database(dbPath);
  try {
    fn(db);
  } finally {
    db.close();
  }
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
    parseShadowEvalArgs(["--db", dbPath, "--out", outPath, "--live", "--max-rollups", "10"]),
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
      "claim_eligible",
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
    parseShadowEvalArgs(["--db", dbPath, "--out", outPath, "--live", "--max-rollups", "10"]),
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

test("a labelled row with no judgement timestamp lands in excluded_no_timestamp under --since", async () => {
  const { dir, dbPath } = makeSeededDb();
  mutateDb(dbPath, (db) => {
    insertRollup(db, "R6", EXCERPT_R6);
    insertAction(db, "A6", "C_GHOST", "R6", 0.8, R2_VOTES);
  });
  const outPath = join(dir, "rows.jsonl");
  const summary = await runShadowEval(
    parseShadowEvalArgs(["--db", dbPath, "--out", outPath, "--since", "2026-09-01T00:00:00Z"]),
    { fetch: recordingFetch([]) },
  );

  expect(summary.excluded_no_timestamp).toBe(1);
  expect(
    summary.unlabelled + summary.excluded_degraded + summary.excluded_no_timestamp + summary.judged,
  ).toBe(summary.total_eligible);
});

test("the degraded window is half-open: a judgement at `to` survives, one at `from` does not", async () => {
  const { dir, dbPath } = makeSeededDb();
  mutateDb(dbPath, (db) => {
    insertRollup(db, "R7", EXCERPT_R7);
    insertRollup(db, "R8", EXCERPT_R8);
    insertCycle(db, "C_FROM", DEFAULT_DEGRADED_WINDOW.from);
    insertCycle(db, "C_TO", DEFAULT_DEGRADED_WINDOW.to);
    insertAction(db, "A7", "C_FROM", "R7", 0.8, R2_VOTES);
    insertAction(db, "A8", "C_TO", "R8", 0.8, R2_VOTES);
  });
  const outPath = join(dir, "rows.jsonl");
  const summary = await runShadowEval(parseShadowEvalArgs(["--db", dbPath, "--out", outPath]), {
    fetch: recordingFetch([]),
  });

  const rows = readRows(outPath);
  expect(rows.map((row) => row["rollup_id"]).sort()).toEqual(["R1", "R5", "R8"]);
  expect(summary.excluded_degraded).toBe(2);
  expect(summary.judged).toBe(3);
});

test("insufficient incumbent ballots are excluded from the agreement denominator", async () => {
  const { dir, dbPath } = makeSeededDb();
  mutateDb(dbPath, (db) => {
    insertRollup(db, "R9", EXCERPT_R9);
    insertCycle(db, "C9", "2026-09-05T08:00:00Z");
    insertAction(db, "A9", "C9", "R9", 0.9, [{ promote: true, confidence: 0.9 }]);
  });
  const outPath = join(dir, "rows.jsonl");
  const calls: RecordedFetchCall[] = [];
  const args = {
    ...parseShadowEvalArgs(["--db", dbPath, "--out", outPath]),
    live: true,
    maxRollups: 10,
  };
  const summary = await runShadowEval(args, {
    fetch: recordingFetch(calls),
    settings: TEST_SETTINGS,
  });

  expect(summary.incumbent_insufficient).toBe(1);
  expect(summary.jev_answered).toBe(3);
  expect(summary.agreement_denominator).toBe(2);
  expect(summary.agreement_denominator).toBe(summary.agreedCount + summary.disagreedCount);
  expect(summary.agreementRate).toBe(1);
});

test("ballots without a real boolean promote are skipped as unparseable, not counted as NO", async () => {
  const verdict = incumbentFromBallots({ ballots: MIXED_BALLOTS, storedConfidence: 0.5 });
  expect(verdict.unparseable).toBe(3);
  expect(verdict.counted).toBe(2);
  expect(verdict.pYes).toBe(0.5);
  expect(verdict.decision).toBe("no_promote");

  const { dir, dbPath } = makeSeededDb();
  mutateDb(dbPath, (db) => {
    insertRollup(db, "R9", EXCERPT_R9);
    insertCycle(db, "C9", "2026-09-05T08:00:00Z");
    insertAction(db, "A9", "C9", "R9", 0.9, MIXED_BALLOTS);
  });
  const outPath = join(dir, "rows.jsonl");
  const summary = await runShadowEval(parseShadowEvalArgs(["--db", dbPath, "--out", outPath]), {
    fetch: recordingFetch([]),
  });
  expect(summary.incumbent_unparseable_ballots).toBe(3);
});

test("--live requires --max-rollups and stays under the rollup and usd caps", async () => {
  const { dir, dbPath } = makeSeededDb();
  mutateDb(dbPath, (db) => {
    insertRollup(db, "R10", EXCERPT_R10);
    insertCycle(db, "C10", "2026-09-06T10:00:00Z");
    insertAction(db, "A10", "C10", "R10", 0.9, R2_VOTES);
  });
  const outPath = join(dir, "rows.jsonl");

  expect(() => parseShadowEvalArgs(["--db", dbPath, "--out", outPath, "--live"])).toThrow(
    /--max-rollups/,
  );

  const base = parseShadowEvalArgs(["--db", dbPath, "--out", outPath]);
  await expectRejection(
    runShadowEval({ ...base, live: true }, { fetch: recordingFetch([]), settings: TEST_SETTINGS }),
    /--max-rollups/,
  );

  const rollupCapCalls: RecordedFetchCall[] = [];
  const rollupCap = await runShadowEval(
    { ...base, live: true, maxRollups: 2 },
    { fetch: recordingFetch(rollupCapCalls), settings: TEST_SETTINGS },
  );
  expect(rollupCapCalls).toHaveLength(2);
  expect(rollupCap.jev_answered).toBe(2);
  expect(rollupCap.max_rollups).toBe(2);
  expect(rollupCap.max_usd).toBe(0.05);

  const usdCapCalls: RecordedFetchCall[] = [];
  const usdCap = await runShadowEval(
    { ...base, live: true, maxRollups: 10, maxUsd: 0.00002 },
    { fetch: recordingFetch(usdCapCalls), settings: TEST_SETTINGS },
  );
  expect(usdCapCalls).toHaveLength(0);
  expect(usdCap.jev_answered).toBe(0);
  expect(usdCap.total_usd).toBe(0);
  expect(usdCap.projected_stop).toBe(true);
  expect(usdCap.max_rollups).toBe(10);
  expect(usdCap.max_usd).toBe(0.00002);
});

test("--live truncates each body sent as state to 16000 characters and counts it", async () => {
  const { dir, dbPath } = makeSeededDb();
  mutateDb(dbPath, (db) => {
    insertRollup(db, "R11", EXCERPT_R11_BODY);
    insertCycle(db, "C11", "2026-09-05T09:00:00Z");
    insertAction(db, "A11", "C11", "R11", 0.9, R2_VOTES);
  });
  const outPath = join(dir, "rows.jsonl");
  const calls: RecordedFetchCall[] = [];
  const args = {
    ...parseShadowEvalArgs(["--db", dbPath, "--out", outPath]),
    live: true,
    maxRollups: 10,
  };
  const summary = await runShadowEval(args, {
    fetch: recordingFetch(calls),
    settings: TEST_SETTINGS,
  });

  const bodies = calls.map((call) => (call.body["state"] as { body: string }).body);
  expect(bodies).toHaveLength(3);
  for (const body of bodies) {
    expect(body.length).toBeLessThanOrEqual(16000);
  }
  expect(bodies.some((body) => body.length === 16000)).toBe(true);
  expect(summary.bodies_truncated).toBe(1);
});

test("the usd cap is a hard bound: projected spend skips calls that would overshoot", async () => {
  const { dir, dbPath } = makeSeededDb();
  mutateDb(dbPath, (db) => {
    insertRollup(db, "R10", EXCERPT_R10);
    insertCycle(db, "C10", "2026-09-06T10:00:00Z");
    insertAction(db, "A10", "C10", "R10", 0.9, R2_VOTES);
  });
  const outPath = join(dir, "rows.jsonl");

  // Rows judge newest-first (R10, R5, R1); a cap of 2.5 estimates fits two.
  const estR10 = liveRequestUsd(EXCERPT_R10);
  const estR5 = liveRequestUsd(EXCERPT_R5);
  const estR1 = liveRequestUsd(EXCERPT_R1);
  const maxUsd = estR10 + estR5 + estR1 / 2;

  const calls: RecordedFetchCall[] = [];
  const summary = await runShadowEval(
    {
      ...parseShadowEvalArgs(["--db", dbPath, "--out", outPath]),
      live: true,
      maxRollups: 10,
      maxUsd,
    },
    { fetch: estimateBillingFetch(calls), settings: TEST_SETTINGS },
  );

  expect(calls).toHaveLength(2);
  expect(calls.map((call) => (call.body["state"] as { body: string }).body)).toEqual([
    EXCERPT_R10,
    EXCERPT_R5,
  ]);
  expect(summary.jev_answered).toBe(2);
  expect(summary.total_usd).toBeLessThanOrEqual(maxUsd);
  expect(summary.total_usd).toBeCloseTo(estR10 + estR5, 10);
  expect(summary.projected_stop).toBe(true);
});

test("a failed live call still spends its estimate, so the usd cap stops the run", async () => {
  const { dir, dbPath } = makeSeededDb();
  mutateDb(dbPath, (db) => {
    insertRollup(db, "R10", EXCERPT_R10);
    insertCycle(db, "C10", "2026-09-06T10:00:00Z");
    insertAction(db, "A10", "C10", "R10", 0.9, R2_VOTES);
  });
  const outPath = join(dir, "rows.jsonl");

  const maxUsd =
    liveRequestUsd(EXCERPT_R10) + liveRequestUsd(EXCERPT_R5) + liveRequestUsd(EXCERPT_R1) / 2;
  const calls: RecordedFetchCall[] = [];
  const failingFetch: TypesafeFetch = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return Promise.resolve(new Response("server error", { status: 500 }));
  };
  const summary = await runShadowEval(
    {
      ...parseShadowEvalArgs(["--db", dbPath, "--out", outPath]),
      live: true,
      maxRollups: 10,
      maxUsd,
    },
    { fetch: failingFetch, settings: TEST_SETTINGS, maxRetries: 0 },
  );

  expect(calls).toHaveLength(2);
  expect(summary.jev_failed).toBe(2);
  expect(summary.jev_answered).toBe(0);
  expect(summary.projected_stop).toBe(true);
});

test("a rollup mixing a timestamp-less and a degraded judgement lands in excluded_no_timestamp", async () => {
  const { dir, dbPath } = makeSeededDb();
  mutateDb(dbPath, (db) => {
    insertRollup(db, "R12", EXCERPT_R12);
    insertCycle(db, "C12_DEGRADED", "2026-09-12T10:00:00Z");
    insertAction(db, "A12_GHOST", "C_GHOST", "R12", 0.8, R2_VOTES);
    insertAction(db, "A12_DEGRADED", "C12_DEGRADED", "R12", 0.8, R2_VOTES);
  });
  const outPath = join(dir, "rows.jsonl");
  const summary = await runShadowEval(
    parseShadowEvalArgs(["--db", dbPath, "--out", outPath, "--since", "2026-09-01T00:00:00Z"]),
    { fetch: recordingFetch([]) },
  );

  expect(summary.excluded_no_timestamp).toBe(1);
  expect(summary.excluded_degraded).toBe(1);
  expect(
    summary.unlabelled + summary.excluded_degraded + summary.excluded_no_timestamp + summary.judged,
  ).toBe(summary.total_eligible);
});

test("an ephemera-pattern excerpt is claim-ineligible and only counts in the full summary", async () => {
  const { dir, dbPath } = makeSeededDb();
  mutateDb(dbPath, (db) => {
    insertRollup(db, "R13", EXCERPT_R13);
    insertCycle(db, "C13", "2026-09-05T11:00:00Z");
    insertAction(db, "A13", "C13", "R13", 0.9, R2_VOTES);
  });
  const outPath = join(dir, "rows.jsonl");
  const summary = await runShadowEval(
    parseShadowEvalArgs(["--db", dbPath, "--out", outPath, "--live", "--max-rollups", "10"]),
    { fetch: recordingFetch([]), settings: TEST_SETTINGS },
  );

  const byId = new Map(readRows(outPath).map((row) => [row["rollup_id"], row]));
  expect(byId.get("R13")?.["claim_eligible"]).toBe(false);

  expect(summary.judged).toBe(3);
  expect(summary.confusion).toEqual({
    both_promote: 1,
    incumbent_only: 1,
    jev_only: 0,
    neither: 1,
  });
  expect(summary.claim_excluded_rows).toBe(1);
  expect(summary.current_claim_eligible.judged).toBe(2);
  expect(summary.current_claim_eligible.confusion).toEqual({
    both_promote: 1,
    incumbent_only: 0,
    jev_only: 0,
    neither: 1,
  });
  expect(summary.current_claim_eligible.agreementRate).toBe(1);
});

test("a rollup from a known long-lived dispatcher user id is claim-ineligible", async () => {
  const [dispatcherUserId] = KNOWN_LONG_LIVED_DISPATCHER_USER_IDS;
  const { dir, dbPath } = makeSeededDb();
  mutateDb(dbPath, (db) => {
    insertRollup(db, "R14", EXCERPT_R14, dispatcherUserId);
    insertCycle(db, "C14", "2026-09-05T11:00:00Z");
    insertAction(db, "A14", "C14", "R14", 0.9, R2_VOTES);
  });
  const outPath = join(dir, "rows.jsonl");
  const summary = await runShadowEval(
    parseShadowEvalArgs(["--db", dbPath, "--out", outPath, "--live", "--max-rollups", "10"]),
    { fetch: recordingFetch([]), settings: TEST_SETTINGS },
  );

  const byId = new Map(readRows(outPath).map((row) => [row["rollup_id"], row]));
  expect(byId.get("R14")?.["claim_eligible"]).toBe(false);

  expect(summary.claim_excluded_rows).toBe(1);
  expect(summary.current_claim_eligible.judged).toBe(2);
  expect(summary.current_claim_eligible.jev_answered).toBe(2);
  expect(summary.current_claim_eligible.confusion.incumbent_only).toBe(0);
});

test("an ordinary rollup is claim-eligible and counted in both summaries", async () => {
  const { dir, dbPath } = makeSeededDb();
  mutateDb(dbPath, (db) => {
    insertRollup(db, "R15", EXCERPT_R15);
    insertCycle(db, "C15", "2026-09-05T11:00:00Z");
    insertAction(db, "A15", "C15", "R15", 0.9, R2_VOTES);
  });
  const outPath = join(dir, "rows.jsonl");
  const summary = await runShadowEval(
    parseShadowEvalArgs(["--db", dbPath, "--out", outPath, "--live", "--max-rollups", "10"]),
    { fetch: recordingFetch([]), settings: TEST_SETTINGS },
  );

  const rows = readRows(outPath);
  const byId = new Map(rows.map((row) => [row["rollup_id"], row]));
  expect(byId.get("R15")?.["claim_eligible"]).toBe(true);
  expect(byId.get("R1")?.["claim_eligible"]).toBe(true);
  expect(byId.get("R5")?.["claim_eligible"]).toBe(true);

  expect(summary.claim_excluded_rows).toBe(0);
  expect(summary.current_claim_eligible.judged).toBe(3);
  expect(summary.current_claim_eligible.confusion).toEqual(summary.confusion);
  expect(summary.current_claim_eligible.agreedCount).toBe(2);
  expect(summary.current_claim_eligible.disagreedCount).toBe(1);
  expect(summary.current_claim_eligible.agreement_denominator).toBe(3);
  expect(summary.current_claim_eligible.agreementRate).toBeCloseTo(2 / 3);
});
