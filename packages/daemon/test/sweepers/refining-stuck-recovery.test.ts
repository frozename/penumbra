import { loadSqliteVec, migrate, T0Writer } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { createRefiningStuckRecoverySweeper } from "@src/sweepers/refining-stuck-recovery.js";

import { TaskDraftReader } from "../../../core/src/readers/task-draft.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  noop();
}

function noop(): void {
  return undefined;
}

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function insertEvent(
  db: Database,
  input: {
    event_id: string;
    ts: string;
    ingest_ts: string;
    project_id: string;
    event_type:
      | "task_draft"
      | "task_draft_refining"
      | "task_draft_promoted"
      | "task_draft_stale"
      | "task_draft_duplicate"
      | "task_draft_escalation";
    payload: unknown;
  },
): void {
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, project_id, user_id, machine_id, event_type, lane, payload_json)
     VALUES (?, ?, ?, 'mcp', ?, 'u', 'm', ?, 'unknown', ?)`,
    [
      input.event_id,
      input.ts,
      input.ingest_ts,
      input.project_id,
      input.event_type,
      JSON.stringify(input.payload),
    ],
  );
}

test("reopens a stuck refining draft and restores it to pending", () => {
  const db = setupDb();
  const reader = new TaskDraftReader({ db });
  const writer = new T0Writer(db);
  const nowMs = Date.parse("2026-05-16T01:00:00.000Z");
  let counter = 0;
  const sweeper = createRefiningStuckRecoverySweeper({
    db,
    reader,
    t0Writer: writer,
    now: () => nowMs,
    uuid: () => `event-${String(++counter)}`,
    machineId: { get: () => "machine-1" },
    log: { info: noop },
  });

  const draftId = "11111111-1111-4111-8111-111111111111";
  insertEvent(db, {
    event_id: "draft",
    ts: "2026-05-16T00:00:00.000Z",
    ingest_ts: "2026-05-16T00:00:01.000Z",
    project_id: "p1",
    event_type: "task_draft",
    payload: {
      draft_id: draftId,
      prompt: "repair me",
      affects_projects: ["p1"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "agent",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  insertEvent(db, {
    event_id: "refining",
    ts: "2026-05-16T00:20:00.000Z",
    ingest_ts: "2026-05-16T00:20:01.000Z",
    project_id: "p1",
    event_type: "task_draft_refining",
    payload: { draft_id: draftId },
  });

  sweeper.tick();

  const latest = reader.listPending({ latest_event_type: "task_draft", project_id: "p1" });
  expect(latest).toHaveLength(1);
  expect(latest[0]?.event_id).toBe("event-1");
  const reopened = db
    .query<{ payload_json: string }, [string]>(
      `SELECT payload_json
       FROM t0_events
       WHERE event_id = ?
       LIMIT 1`,
    )
    .get("event-1");
  expect(JSON.parse(reopened?.payload_json ?? "{}")).toMatchObject({
    draft_id: draftId,
    recovery_count: 1,
    recovered_from: "refining_stuck",
  });

  const events = db
    .query<
      { event_type: string; payload_json: string },
      [string]
    >(`SELECT event_type, payload_json FROM t0_events WHERE json_extract(payload_json, '$.draft_id') = ? ORDER BY ts ASC, ingest_ts ASC, event_id ASC`)
    .all(draftId);
  expect(events.map((row) => row.event_type)).toEqual([
    "task_draft",
    "task_draft_refining",
    "task_draft",
  ]);
});

test("exhausted stuck refining draft is marked stale", () => {
  const db = setupDb();
  const reader = new TaskDraftReader({ db });
  const writer = new T0Writer(db);
  const nowMs = Date.parse("2026-05-16T01:00:00.000Z");
  let counter = 0;
  const sweeper = createRefiningStuckRecoverySweeper({
    db,
    reader,
    t0Writer: writer,
    now: () => nowMs,
    uuid: () => `event-${String(++counter)}`,
    machineId: { get: () => "machine-1" },
    log: { info: noop },
  });

  const draftId = "22222222-2222-4222-8222-222222222222";
  insertEvent(db, {
    event_id: "draft",
    ts: "2026-05-16T00:00:00.000Z",
    ingest_ts: "2026-05-16T00:00:01.000Z",
    project_id: "p1",
    event_type: "task_draft",
    payload: {
      draft_id: draftId,
      prompt: "repair me",
      affects_projects: ["p1"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "agent",
      filed_via: "skill_inline",
      parent_draft_id: null,
      recovery_count: 2,
    },
  });
  insertEvent(db, {
    event_id: "refining",
    ts: "2026-05-16T00:20:00.000Z",
    ingest_ts: "2026-05-16T00:20:01.000Z",
    project_id: "p1",
    event_type: "task_draft_refining",
    payload: { draft_id: draftId },
  });

  sweeper.tick();

  const stale = db
    .query<
      { event_type: string; payload_json: string },
      [string]
    >(`SELECT event_type, payload_json FROM t0_events WHERE json_extract(payload_json, '$.draft_id') = ? AND event_type = 'task_draft_stale' ORDER BY ts DESC, ingest_ts DESC LIMIT 1`)
    .get(draftId);
  expect(stale?.event_type).toBe("task_draft_stale");
  expect(JSON.parse(stale?.payload_json ?? "{}")).toMatchObject({
    draft_id: draftId,
    stale_reason: "refining_stuck_exhausted",
  });
});

test("poison-pill row does not block recovery of other stuck drafts", () => {
  const db = setupDb();
  const reader = new TaskDraftReader({ db });
  const writer = new T0Writer(db);
  const nowMs = Date.parse("2026-05-16T01:00:00.000Z");
  let counter = 0;
  const logs: { obj: Record<string, unknown>; msg: string }[] = [];
  const sweeper = createRefiningStuckRecoverySweeper({
    db,
    reader,
    t0Writer: writer,
    now: () => nowMs,
    uuid: () => `event-${String(++counter)}`,
    machineId: { get: () => "machine-1" },
    log: { info: (obj, msg) => logs.push({ obj, msg }) },
  });

  const goodDraftId = "44444444-4444-4444-8444-444444444444";
  const poisonDraftId = "55555555-5555-4555-8555-555555555555";

  // Poison-pill draft: payload parses as JSON but fails TaskDraftPayloadSchema
  // (missing required `prompt`, `affects_projects`, etc.). draft_id itself is
  // a valid UUID so the json_extract → row.draft_id path returns it cleanly.
  insertEvent(db, {
    event_id: "poison-draft",
    ts: "2026-05-16T00:00:00.000Z",
    ingest_ts: "2026-05-16T00:00:01.000Z",
    project_id: "p1",
    event_type: "task_draft",
    payload: { draft_id: poisonDraftId, totally_malformed: true },
  });
  insertEvent(db, {
    event_id: "poison-refining",
    ts: "2026-05-16T00:10:00.000Z",
    ingest_ts: "2026-05-16T00:10:01.000Z",
    project_id: "p1",
    event_type: "task_draft_refining",
    payload: { draft_id: poisonDraftId },
  });

  // Healthy stuck draft that must still recover despite the poison row above.
  insertEvent(db, {
    event_id: "good-draft",
    ts: "2026-05-16T00:05:00.000Z",
    ingest_ts: "2026-05-16T00:05:01.000Z",
    project_id: "p1",
    event_type: "task_draft",
    payload: {
      draft_id: goodDraftId,
      prompt: "repair me too",
      affects_projects: ["p1"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "agent",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });
  insertEvent(db, {
    event_id: "good-refining",
    ts: "2026-05-16T00:15:00.000Z",
    ingest_ts: "2026-05-16T00:15:01.000Z",
    project_id: "p1",
    event_type: "task_draft_refining",
    payload: { draft_id: goodDraftId },
  });

  sweeper.tick();

  const goodRecovered = db
    .query<
      { n: number },
      [string]
    >(`SELECT COUNT(*) AS n FROM t0_events WHERE json_extract(payload_json, '$.draft_id') = ? AND event_type = 'task_draft' AND json_extract(payload_json, '$.recovered_from') = 'refining_stuck'`)
    .get(goodDraftId);
  expect(goodRecovered?.n).toBe(1);

  // Poison row should be marked stale so it stops being re-selected next tick.
  const poisonStale = db
    .query<
      { payload_json: string },
      [string]
    >(`SELECT payload_json FROM t0_events WHERE json_extract(payload_json, '$.draft_id') = ? AND event_type = 'task_draft_stale' ORDER BY ts DESC, ingest_ts DESC LIMIT 1`)
    .get(poisonDraftId);
  expect(poisonStale).toBeTruthy();
  expect(JSON.parse(poisonStale?.payload_json ?? "{}")).toMatchObject({
    draft_id: poisonDraftId,
    stale_reason: "refining_stuck",
  });

  // Skip was logged and counted in the tick summary.
  const tickSummary = logs.find((l) => l.msg === "refining-stuck-recovery tick");
  expect(tickSummary?.obj).toMatchObject({ recovered: 1, skipped_invalid: 1 });

  // Second tick: poison row no longer surfaces, no new events on either id.
  const beforeSecondTick = db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM t0_events`).get() as {
    n: number;
  };
  sweeper.tick();
  const afterSecondTick = db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM t0_events`).get() as {
    n: number;
  };
  expect(afterSecondTick.n).toBe(beforeSecondTick.n);
});

test("already-open draft is untouched on subsequent tick", () => {
  const db = setupDb();
  const reader = new TaskDraftReader({ db });
  const writer = new T0Writer(db);
  const nowMs = Date.parse("2026-05-16T01:00:00.000Z");
  let counter = 0;
  const sweeper = createRefiningStuckRecoverySweeper({
    db,
    reader,
    t0Writer: writer,
    now: () => nowMs,
    uuid: () => `event-${String(++counter)}`,
    machineId: { get: () => "machine-1" },
    log: { info: noop },
  });

  const draftId = "33333333-3333-4333-8333-333333333333";
  insertEvent(db, {
    event_id: "draft",
    ts: "2026-05-16T00:00:00.000Z",
    ingest_ts: "2026-05-16T00:00:01.000Z",
    project_id: "p1",
    event_type: "task_draft",
    payload: {
      draft_id: draftId,
      prompt: "ready",
      affects_projects: ["p1"],
      evidence: {},
      auto_ok: true,
      filed_by_agent: "agent",
      filed_via: "skill_inline",
      parent_draft_id: null,
    },
  });

  sweeper.tick();
  sweeper.tick();

  const rows = db
    .query<
      { n: number },
      [string]
    >(`SELECT COUNT(*) AS n FROM t0_events WHERE json_extract(payload_json, '$.draft_id') = ? AND event_type = 'task_draft'`)
    .get(draftId);
  expect(rows?.n).toBe(1);
});
