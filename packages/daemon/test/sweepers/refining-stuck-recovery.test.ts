import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { T0Writer, loadSqliteVec, migrate } from "@penumbra/core";
import { TaskDraftReader } from "../../../core/src/readers/task-draft.js";
import { createRefiningStuckRecoverySweeper } from "../../src/sweepers/refining-stuck-recovery.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

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
) {
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
  let nowMs = Date.parse("2026-05-16T01:00:00.000Z");
  let counter = 0;
  const sweeper = createRefiningStuckRecoverySweeper({
    db,
    reader,
    t0Writer: writer,
    now: () => nowMs,
    uuid: () => `event-${++counter}`,
    machineId: { get: () => "machine-1" },
    log: { info: () => {} },
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
  let nowMs = Date.parse("2026-05-16T01:00:00.000Z");
  let counter = 0;
  const sweeper = createRefiningStuckRecoverySweeper({
    db,
    reader,
    t0Writer: writer,
    now: () => nowMs,
    uuid: () => `event-${++counter}`,
    machineId: { get: () => "machine-1" },
    log: { info: () => {} },
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

test("already-open draft is untouched on subsequent tick", () => {
  const db = setupDb();
  const reader = new TaskDraftReader({ db });
  const writer = new T0Writer(db);
  let nowMs = Date.parse("2026-05-16T01:00:00.000Z");
  let counter = 0;
  const sweeper = createRefiningStuckRecoverySweeper({
    db,
    reader,
    t0Writer: writer,
    now: () => nowMs,
    uuid: () => `event-${++counter}`,
    machineId: { get: () => "machine-1" },
    log: { info: () => {} },
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
