import { loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runSessionEventsSource } from "@src/recall-sources/session-events.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

test("session_id filter: returns only matching session rows", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO session_events (id, session_id, related_session_id, project_id, cwd, transcript_path, ref_path, kind, ts, meta_json)
    VALUES
      (1, 's-1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T10:00:00Z', '{}'),
      (2, 's-2', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T10:01:00Z', '{}'),
      (3, 's-1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.tool_call', '2026-05-04T10:02:00Z', '{}');
  `);

  const out = runSessionEventsSource({ db, args: { session_id: "s-1" } });
  expect(out.events.map((e) => e.id)).toEqual([3, 1]);
  expect(out.warnings).toEqual([]);
});

test("since filter is inclusive (ts >= since): returns rows at and after the boundary", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO session_events (id, session_id, related_session_id, project_id, cwd, transcript_path, ref_path, kind, ts, meta_json)
    VALUES
      (1, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T10:00:00Z', '{}'),
      (2, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T11:00:00Z', '{}'),
      (3, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T12:00:00Z', '{}');
  `);

  const out = runSessionEventsSource({
    db,
    args: { session_id: "s1", since: "2026-05-04T11:00:00Z" },
  });
  expect(out.events.map((e) => e.id)).toEqual([3, 2]);
  expect(out.warnings).toEqual([]);
});

test("filters combine with AND: session_id plus since excludes mismatched rows", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO session_events (id, session_id, related_session_id, project_id, cwd, transcript_path, ref_path, kind, ts, meta_json)
    VALUES
      (1, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T10:00:00Z', '{}'),
      (2, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T12:00:00Z', '{}'),
      (3, 's2', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T12:30:00Z', '{}');
  `);

  const out = runSessionEventsSource({
    db,
    args: { session_id: "s1", since: "2026-05-04T11:00:00Z" },
  });
  expect(out.events.map((e) => e.id)).toEqual([2]);
  expect(out.warnings).toEqual([]);
});

test("default limit is 100: 101 rows returns 100", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.transaction(() => {
    for (let i = 1; i <= 101; i += 1) {
      db.run(
        `INSERT INTO session_events (id, session_id, related_session_id, project_id, cwd, transcript_path, ref_path, kind, ts, meta_json)
         VALUES (?, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T10:00:00Z', '{}')`,
      );
    }
  })();

  const out = runSessionEventsSource({ db, args: {} });
  expect(out.events).toHaveLength(100);
  expect(out.warnings).toEqual([]);
});

test("limit 0 falls back to the default of 100 rather than clamping to 1", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.transaction(() => {
    for (let i = 1; i <= 101; i += 1) {
      db.run(
        `INSERT INTO session_events (id, session_id, related_session_id, project_id, cwd, transcript_path, ref_path, kind, ts, meta_json)
         VALUES (?, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T10:00:00Z', '{}')`,
      );
    }
  })();

  const out = runSessionEventsSource({ db, args: { limit: 0 } });
  expect(out.events).toHaveLength(100);
  expect(out.warnings).toEqual([]);
});

test("negative limit clamps to 1: returns exactly the newest row", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO session_events (id, session_id, related_session_id, project_id, cwd, transcript_path, ref_path, kind, ts, meta_json)
    VALUES
      (1, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T10:00:00Z', '{}'),
      (2, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T11:00:00Z', '{}'),
      (3, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T12:00:00Z', '{}');
  `);

  const out = runSessionEventsSource({ db, args: { limit: -5 } });
  expect(out.events.map((e) => e.id)).toEqual([3]);
  expect(out.warnings).toEqual([]);
});

test("ordering is ts DESC, then id DESC on ties", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO session_events (id, session_id, related_session_id, project_id, cwd, transcript_path, ref_path, kind, ts, meta_json)
    VALUES
      (1, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T10:00:00Z', '{}'),
      (2, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T12:00:00Z', '{}'),
      (3, 's1', NULL, 'p1', '/cwd', 'tp', 'rp', 'agent.thought', '2026-05-04T12:00:00Z', '{}');
  `);

  const out = runSessionEventsSource({ db, args: {} });
  expect(out.events.map((e) => e.id)).toEqual([3, 2, 1]);
  expect(out.warnings).toEqual([]);
});

test("returned rows carry all projected columns including nullable fields", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO session_events (id, session_id, related_session_id, project_id, cwd, transcript_path, ref_path, kind, ts, meta_json)
    VALUES (1, 's1', 's2', 'p1', '/project', '/transcript/path', '/ref/path', 'agent.thought', '2026-05-04T10:00:00Z', '{"key":"value"}');
  `);

  const out = runSessionEventsSource({ db, args: {} });
  expect(out.events).toHaveLength(1);
  const row = out.events[0];
  expect(row).toEqual({
    id: 1,
    session_id: "s1",
    related_session_id: "s2",
    project_id: "p1",
    cwd: "/project",
    transcript_path: "/transcript/path",
    ref_path: "/ref/path",
    kind: "agent.thought",
    ts: "2026-05-04T10:00:00Z",
    meta_json: '{"key":"value"}',
  });
  expect(out.warnings).toEqual([]);
});

test("error path: no migrate returns empty events with warning starting with 'session_events: '", () => {
  const db = new Database(":memory:");
  // intentionally skip loadSqliteVec and migrate

  const out = runSessionEventsSource({ db, args: {} });
  expect(out.events).toEqual([]);
  expect(out.warnings).toHaveLength(1);
  expect(out.warnings[0]).toMatch(/^session_events: /);
});
