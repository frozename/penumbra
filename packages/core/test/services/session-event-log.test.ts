import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { type SessionEventInput, SessionEventLog } from "@src/services/session-event-log.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

const sampleEvent: SessionEventInput = {
  session_id: "s-1",
  related_session_id: "s-0",
  project_id: "proj",
  cwd: "/repo",
  transcript_path: "/tmp/transcript.jsonl",
  ref_path: "/tmp/ref.md",
  kind: "continuity.boot_pickup",
  ts: "2026-05-01T00:00:00.000Z",
  meta: { first_moves: ["read plan", "run tests"] },
};

describe("SessionEventLog", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test("record() -> listBySession() round-trips a dotted kind with json meta", () => {
    const log = new SessionEventLog(db);
    const insertedId = log.record(sampleEvent);

    const rows = log.listBySession("s-1");
    expect(rows).toHaveLength(1);
    expect(insertedId).toBe(rows[0]!.id);
    expect(rows[0]!.session_id).toBe("s-1");
    expect(rows[0]!.related_session_id).toBe("s-0");
    expect(rows[0]!.kind).toBe("continuity.boot_pickup");
    expect(rows[0]!.meta_json ? JSON.parse(rows[0]!.meta_json) : null).toEqual(sampleEvent.meta);
  });

  test("listContinuityChain(id) merges rows where session_id=X with rows where related_session_id=X, ts-ordered", () => {
    const log = new SessionEventLog(db);
    log.record({
      ...sampleEvent,
      session_id: "s-1",
      related_session_id: null,
      kind: "session.start",
      ts: "2026-05-01T00:00:02.000Z",
    });
    log.record({
      ...sampleEvent,
      session_id: "s-2",
      related_session_id: "s-1",
      kind: "continuity.boot_pickup",
      ts: "2026-05-01T00:00:01.000Z",
    });
    log.record({
      ...sampleEvent,
      session_id: "s-3",
      related_session_id: "other",
      kind: "session.start",
      ts: "2026-05-01T00:00:00.000Z",
    });

    expect(log.listContinuityChain("s-1").map((row) => row.session_id)).toEqual(["s-2", "s-1"]);
  });

  test("resolveSourceSessionForNote(path) returns the newest skeleton_generated session_id", () => {
    const log = new SessionEventLog(db);
    log.record({
      ...sampleEvent,
      session_id: "older",
      related_session_id: null,
      kind: "continuity.skeleton_generated",
      ref_path: "/tmp/note.md",
      ts: "2026-05-01T00:00:00.000Z",
    });
    log.record({
      ...sampleEvent,
      session_id: "newer",
      related_session_id: null,
      kind: "continuity.skeleton_generated",
      ref_path: "/tmp/note.md",
      ts: "2026-05-01T00:00:01.000Z",
    });
    log.record({
      ...sampleEvent,
      session_id: "draft",
      related_session_id: null,
      kind: "continuity.draft_composed",
      ref_path: "/tmp/note.md",
      ts: "2026-05-01T00:00:02.000Z",
    });

    expect(log.resolveSourceSessionForNote("/tmp/note.md")).toBe("newer");
  });

  test("listRecent treats kind_prefix %, _, and literal text as escaped prefixes", () => {
    db.run(`
      INSERT INTO session_events (session_id, kind, ts, meta_json)
      VALUES
        ('s-1', '%literal', '2026-05-01T00:00:00.000Z', NULL),
        ('s-1', '_literal', '2026-05-01T00:00:01.000Z', NULL),
        ('s-1', 'continuity.boot_pickup', '2026-05-01T00:00:02.000Z', NULL),
        ('s-1', 'continuityXboot_pickup', '2026-05-01T00:00:03.000Z', NULL),
        ('s-1', 'session.start', '2026-05-01T00:00:04.000Z', NULL)
    `);
    const log = new SessionEventLog(db);

    expect(log.listRecent({ kind_prefix: "%" }).map((row) => row.kind)).toEqual(["%literal"]);
    expect(log.listRecent({ kind_prefix: "_" }).map((row) => row.kind)).toEqual(["_literal"]);
    expect(log.listRecent({ kind_prefix: "continuity." }).map((row) => row.kind)).toEqual([
      "continuity.boot_pickup",
    ]);
  });

  test("listBySession defaults to 500 rows", () => {
    const insert = db.transaction((count: number) => {
      for (let i = 0; i < count; i += 1) {
        db.run(
          `INSERT INTO session_events (session_id, kind, ts, meta_json)
           VALUES (?, 'session.start', ?, NULL)`,
          ["bounded", `2026-05-01T00:${String(i).padStart(2, "0")}:00.000Z`],
        );
      }
    });
    insert(501);

    const log = new SessionEventLog(db);
    expect(log.listBySession("bounded")).toHaveLength(500);
  });

  test("listContinuityChain caps caller-provided limits at 5000 rows", () => {
    const insert = db.transaction((count: number) => {
      for (let i = 0; i < count; i += 1) {
        db.run(
          `INSERT INTO session_events (session_id, related_session_id, kind, ts, meta_json)
           VALUES (?, 'root', 'continuity.boot_pickup', ?, NULL)`,
          [`child-${String(i)}`, `2026-05-01T00:${String(i).padStart(2, "0")}:00.000Z`],
        );
      }
    });
    insert(5001);

    const log = new SessionEventLog(db);
    expect(log.listContinuityChain("root", 10000)).toHaveLength(5000);
  });
});
