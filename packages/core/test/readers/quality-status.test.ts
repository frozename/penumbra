import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { qualityStatus } from "@src/readers/quality-status.js";
import { EXECUTE_OUTCOMES, FAILURE_OUTCOMES, isExecuteOutcome } from "@src/workflows/outcomes.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // Optional Homebrew SQLite is unavailable in some CI images.
}

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function insertT0Event(
  db: Database,
  args: {
    event_id: string;
    ts: string;
    event_type: string;
    latency_ms: number | null;
    payload: unknown;
  },
): void {
  db.prepare(
    `
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id,
      user_id, machine_id, session_id, event_type, lane,
      provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
      request_id, payload_json, payload_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, NULL)
  `,
  ).run(
    args.event_id,
    args.ts,
    args.ts,
    "agentchat",
    "workflows",
    null,
    "penumbra",
    "machine",
    null,
    args.event_type,
    "local",
    args.latency_ms,
    JSON.stringify(args.payload),
  );
}

const FIXED = "2026-04-23T12:00:00.000Z";
const NOW = new Date(FIXED);

function tsMinutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
}

test("Test 1 — three-way classification: success, failure, unknown", () => {
  const db = makeDb();
  insertT0Event(db, {
    event_id: "r1",
    ts: tsMinutesAgo(60),
    event_type: "workflow.outcome",
    latency_ms: 10,
    payload: { workflow_name: "adversarial-review", outcome: "success", latency_ms: 10 },
  });
  insertT0Event(db, {
    event_id: "r2",
    ts: tsMinutesAgo(50),
    event_type: "workflow.outcome",
    latency_ms: 10,
    payload: { workflow_name: "adversarial-review", outcome: "run_error", latency_ms: 10 },
  });
  insertT0Event(db, {
    event_id: "r3",
    ts: tsMinutesAgo(40),
    event_type: "workflow.outcome",
    latency_ms: 10,
    payload: { workflow_name: "adversarial-review", outcome: "banana", latency_ms: 10 },
  });

  const snap = qualityStatus(db, { now: NOW, workflow_name: "adversarial-review" });
  const adv = snap.adversarial!;
  expect(adv.runs_window).toBe(3);
  expect(adv.success_window).toBe(1);
  expect(adv.failure_window).toBe(1);
  expect(adv.unknown_outcome_window).toBe(1);
  expect(adv.runs_window).toBe(
    adv.success_window + adv.failure_window + adv.unknown_outcome_window,
  );
});

test("Test 2 — NULL and absent-key rows count as unknown (Decision C)", () => {
  const db = makeDb();
  insertT0Event(db, {
    event_id: "n1",
    ts: tsMinutesAgo(60),
    event_type: "workflow.outcome",
    latency_ms: 100,
    payload: { workflow_name: "w", outcome: "success", latency_ms: 100 },
  });
  insertT0Event(db, {
    event_id: "n2",
    ts: tsMinutesAgo(50),
    event_type: "workflow.outcome",
    latency_ms: 100,
    payload: { workflow_name: "w", outcome: "gated_failure", latency_ms: 100 },
  });
  insertT0Event(db, {
    event_id: "n3",
    ts: tsMinutesAgo(40),
    event_type: "workflow.outcome",
    latency_ms: 100,
    payload: { workflow_name: "w", outcome: null, latency_ms: 100 },
  });
  insertT0Event(db, {
    event_id: "n4",
    ts: tsMinutesAgo(30),
    event_type: "workflow.outcome",
    latency_ms: 100,
    payload: { workflow_name: "w", latency_ms: 100 },
  });

  const snap = qualityStatus(db, { now: NOW, workflow_name: "w" });
  const adv = snap.adversarial!;
  expect(adv.runs_window).toBe(4);
  expect(adv.success_window).toBe(1);
  expect(adv.failure_window).toBe(1);
  expect(adv.unknown_outcome_window).toBe(2);
  expect(adv.avg_latency_ms_window).toBe(100);
  expect(adv.runs_window).toBe(
    adv.success_window + adv.failure_window + adv.unknown_outcome_window,
  );
});

test("Test 3 — non-default workflow_name is honoured", () => {
  const db = makeDb();
  insertT0Event(db, {
    event_id: "s1",
    ts: tsMinutesAgo(60),
    event_type: "workflow.outcome",
    latency_ms: 5,
    payload: { workflow_name: "session-memory-sweep", outcome: "run_error", latency_ms: 5 },
  });
  insertT0Event(db, {
    event_id: "s2",
    ts: tsMinutesAgo(50),
    event_type: "workflow.outcome",
    latency_ms: 5,
    payload: { workflow_name: "session-memory-sweep", outcome: "success", latency_ms: 5 },
  });
  insertT0Event(db, {
    event_id: "a1",
    ts: tsMinutesAgo(40),
    event_type: "workflow.outcome",
    latency_ms: 5,
    payload: { workflow_name: "adversarial-review", outcome: "success", latency_ms: 5 },
  });

  const swept = qualityStatus(db, { now: NOW, workflow_name: "session-memory-sweep" });
  expect(swept.adversarial?.runs_window).toBe(2);
  expect(swept.adversarial?.runs_window).toBe(
    (swept.adversarial?.success_window ?? 0) +
      (swept.adversarial?.failure_window ?? 0) +
      (swept.adversarial?.unknown_outcome_window ?? 0),
  );

  const defaulted = qualityStatus(db, { now: NOW });
  expect(defaulted.adversarial?.runs_window).toBe(1);
  expect(defaulted.adversarial?.runs_window).toBe(
    (defaulted.adversarial?.success_window ?? 0) +
      (defaulted.adversarial?.failure_window ?? 0) +
      (defaulted.adversarial?.unknown_outcome_window ?? 0),
  );
});

test("Test 4 — all four vocabulary members classify correctly", () => {
  const db = makeDb();
  insertT0Event(db, {
    event_id: "v1",
    ts: tsMinutesAgo(60),
    event_type: "workflow.outcome",
    latency_ms: 10,
    payload: { workflow_name: "w", outcome: "success", latency_ms: 10 },
  });
  insertT0Event(db, {
    event_id: "v2",
    ts: tsMinutesAgo(50),
    event_type: "workflow.outcome",
    latency_ms: 10,
    payload: { workflow_name: "w", outcome: "render_error", latency_ms: 10 },
  });
  insertT0Event(db, {
    event_id: "v3",
    ts: tsMinutesAgo(40),
    event_type: "workflow.outcome",
    latency_ms: 10,
    payload: { workflow_name: "w", outcome: "run_error", latency_ms: 10 },
  });
  insertT0Event(db, {
    event_id: "v4",
    ts: tsMinutesAgo(30),
    event_type: "workflow.outcome",
    latency_ms: 10,
    payload: { workflow_name: "w", outcome: "gated_failure", latency_ms: 10 },
  });

  const snap = qualityStatus(db, { now: NOW, workflow_name: "w" });
  const adv = snap.adversarial!;
  expect(adv.runs_window).toBe(4);
  expect(adv.success_window).toBe(1);
  expect(adv.failure_window).toBe(3);
  expect(adv.unknown_outcome_window).toBe(0);
  expect(adv.runs_window).toBe(
    adv.success_window + adv.failure_window + adv.unknown_outcome_window,
  );
});

test("Test 5 — FAILURE_OUTCOMES is derived from EXECUTE_OUTCOMES and cannot drift", () => {
  // This module exists so one vocabulary drives every classifier. Restating the failure set
  // as a second literal is the exact drift the task closes, so pin the derivation here: a
  // fifth outcome added to EXECUTE_OUTCOMES fails this test rather than silently miscounting.
  expect([...FAILURE_OUTCOMES].sort()).toEqual(
    EXECUTE_OUTCOMES.filter((outcome) => outcome !== "success").sort(),
  );
  for (const outcome of EXECUTE_OUTCOMES) {
    expect(isExecuteOutcome(outcome)).toBe(true);
    expect(outcome === "success" || FAILURE_OUTCOMES.has(outcome)).toBe(true);
  }
  expect(FAILURE_OUTCOMES.has("success")).toBe(false);
  expect(isExecuteOutcome("failure")).toBe(false);
  expect(isExecuteOutcome("failed")).toBe(false);
});
