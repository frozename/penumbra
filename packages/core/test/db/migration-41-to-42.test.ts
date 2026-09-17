import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { migrate } from "@src/db/migrations.js";
import { SCHEMA_VERSION } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

// The deployed v41 registrar_events DDL, verbatim from live production: 7-kind
// CHECK and the character-count body CHECK. The rebuild deliberately upgrades
// the body CHECK to the byte-bounded form.
const DEPLOYED_V41_REGISTRAR_EVENTS_DDL = `
CREATE TABLE registrar_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  registrar_id TEXT NOT NULL REFERENCES registrar_entries(registrar_id),
  phase_no INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('progress','caveat','blocker','follow_up','decision','phase_transition','link')),
  state TEXT,
  ref_event_id INTEGER REFERENCES registrar_events(event_id),
  link_kind TEXT CHECK (link_kind IS NULL OR link_kind IN ('commit_sha','handoff_id','lane_id','workflow_run_id','memory_id','plan_id','gh_issue')),
  link_value TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('maestro','worker','sweeper','operator')),
  body TEXT NOT NULL CHECK (length(body) <= 4096),
  created_at INTEGER NOT NULL,
  CHECK ((kind = 'blocker' AND state IN ('opened','resolved')) OR (kind = 'follow_up' AND state IN ('owed','done','dropped')) OR (kind = 'phase_transition' AND state IN ('pending','active','blocked','complete','abandoned')) OR (kind NOT IN ('blocker','follow_up','phase_transition') AND state IS NULL)),
  CHECK (kind != 'link' OR (link_kind IS NOT NULL AND link_value IS NOT NULL)),
  CHECK (state NOT IN ('resolved','done','dropped') OR ref_event_id IS NOT NULL)
)`;

function makeV41Db(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.run("DROP TABLE IF EXISTS registrar_events");
  db.run(DEPLOYED_V41_REGISTRAR_EVENTS_DDL);
  db.run(
    `INSERT INTO registrar_entries
       (registrar_id, slug, title, home_project, source_doc_path, status, created_at, updated_at)
     VALUES ('registrar-1', 'registrar-one', 'Registrar one', 'penumbra', NULL, 'active', 100, 100)`,
  );
  db.run(
    `INSERT INTO registrar_events
       (event_id, registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
     VALUES (1, 'registrar-1', NULL, 'progress', NULL, NULL, NULL, NULL, 'maestro', 'first event', 100)`,
  );
  db.run(
    `INSERT INTO registrar_events
       (event_id, registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
     VALUES (2, 'registrar-1', 1, 'phase_transition', 'active', NULL, NULL, NULL, 'maestro', 'second event', 101)`,
  );
  db.run("UPDATE db_meta SET value = '41' WHERE key = 'schema_version'");
  return db;
}

function registrarEventsSql(db: Database): string {
  const ddl = db
    .query<
      { sql: string },
      []
    >("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'registrar_events'")
    .get()?.sql;
  if (!ddl) throw new Error("registrar_events table is missing");
  return ddl;
}

function normalizeRegistrarEventsCreate(sql: string): string {
  return sql
    .replace("CREATE TABLE IF NOT EXISTS registrar_events", "CREATE TABLE registrar_events")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function extractRegistrarEventsCreate(sql: string): string {
  const start = /CREATE TABLE(?: IF NOT EXISTS)? registrar_events \(/.exec(sql);
  if (!start) throw new Error("registrar_events CREATE TABLE block not found");
  const end = /\n[ \t]*\);?/.exec(sql.slice(start.index + start[0].length));
  if (!end) throw new Error("registrar_events CREATE TABLE block not found");
  const endIndex = start.index + start[0].length + end.index + end[0].length;
  return sql.slice(start.index, endIndex);
}

function extractRegistrarEventsMigrationFunction(source: string): string {
  const start = source.indexOf("function ensureRegistrarEventsEntryTransitionKind(db: Database)");
  const end = source.indexOf("export function runStartupZombieSweep", start);
  if (start === -1 || end === -1) {
    throw new Error("ensureRegistrarEventsEntryTransitionKind function not found");
  }
  return source.slice(start, end);
}

test("migrate() rebuilds a deployed v41 registrar_events with the entry_transition kind and preserves rows", () => {
  const db = makeV41Db();

  migrate(db, { embeddingDim: 384 });

  const ddl = registrarEventsSql(db);
  expect(ddl).toContain("entry_transition");
  expect(ddl).toContain("CAST(body AS BLOB)");

  expect(
    db
      .query<
        { event_id: number; kind: string; state: string | null; created_at: number },
        []
      >("SELECT event_id, kind, state, created_at FROM registrar_events ORDER BY event_id")
      .all(),
  ).toEqual([
    { event_id: 1, kind: "progress", state: null, created_at: 100 },
    { event_id: 2, kind: "phase_transition", state: "active", created_at: 101 },
  ]);

  // AUTOINCREMENT continuity: the explicit-event_id copy must advance sqlite_sequence.
  db.run(
    `INSERT INTO registrar_events
       (registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
     VALUES ('registrar-1', NULL, 'entry_transition', 'complete', NULL, NULL, NULL, 'maestro', 'closed', 102)`,
  );
  expect(
    db
      .query<
        { event_id: number },
        []
      >("SELECT event_id FROM registrar_events WHERE kind = 'entry_transition'")
      .get()?.event_id,
  ).toBe(3);

  expect(() =>
    db.run(
      `INSERT INTO registrar_events
         (registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
       VALUES ('registrar-1', NULL, 'sabotage', NULL, NULL, NULL, NULL, 'maestro', 'nope', 103)`,
    ),
  ).toThrow();

  const indexes = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'registrar_events' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map((row) => row.name);
  expect(indexes).toContain("registrar_events_by_entry");
  expect(indexes).toContain("registrar_events_open_state");
});

test("migrate() is idempotent for the registrar_events entry_transition rebuild", () => {
  const db = makeV41Db();

  migrate(db, { embeddingDim: 384 });
  const countAfterFirst = db
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM registrar_events")
    .get()?.count;
  expect(countAfterFirst).toBe(2);

  migrate(db, { embeddingDim: 384 });

  expect(
    db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM registrar_events").get()?.count,
  ).toBe(countAfterFirst);
});

test("migrate() aborts the v41 registrar_events rebuild when an existing body exceeds 4096 bytes and leaves the table untouched", () => {
  const db = makeV41Db();
  const multibyteBody = "€".repeat(3000);
  db.run(
    `INSERT INTO registrar_events
       (event_id, registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
     VALUES (3, 'registrar-1', NULL, 'progress', NULL, NULL, NULL, NULL, 'maestro', ?, 102)`,
    [multibyteBody],
  );

  expect(() => {
    migrate(db, { embeddingDim: 384 });
  }).toThrow(
    "registrar_events contains bodies over 4096 bytes for event_id(s): 3; shorten these bodies below 4096 bytes, then restart",
  );

  expect(
    db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'registrar_events'")
      .get()?.name,
  ).toBe("registrar_events");
  expect(
    db.query<{ body: string }, []>("SELECT body FROM registrar_events WHERE event_id = 3").get()
      ?.body,
  ).toBe(multibyteBody);
  expect(registrarEventsSql(db)).toContain("length(body) <= 4096");
});

test("migrate() preserves the registrar_events AUTOINCREMENT high-water mark after rebuilding", () => {
  const db = makeV41Db();
  db.run(
    `INSERT INTO registrar_events
       (event_id, registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
     VALUES (3, 'registrar-1', NULL, 'progress', NULL, NULL, NULL, NULL, 'maestro', 'deleted event', 102)`,
  );
  db.run("DELETE FROM registrar_events WHERE event_id = 3");

  expect(
    db
      .query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'registrar_events'")
      .get()?.seq,
  ).toBe(3);

  migrate(db, { embeddingDim: 384 });
  db.run(
    `INSERT INTO registrar_events
       (registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
     VALUES ('registrar-1', NULL, 'progress', NULL, NULL, NULL, NULL, 'maestro', 'after rebuild', 103)`,
  );

  expect(
    db
      .query<
        { event_id: number },
        []
      >("SELECT event_id FROM registrar_events WHERE body = 'after rebuild'")
      .get()?.event_id,
  ).toBe(4);
});

test("migrate() registrar_events CREATE TABLE DDL stays pinned to SCHEMA_DDL_BLOCK_15", () => {
  const source = readFileSync("packages/core/src/db/schema.ts", "utf8");
  const schemaBlock = /const SCHEMA_DDL_BLOCK_15 = `([\s\S]*?)`;/.exec(source)?.[1];
  if (!schemaBlock) throw new Error("SCHEMA_DDL_BLOCK_15 not found");
  const migrationFunction = extractRegistrarEventsMigrationFunction(source);

  expect(normalizeRegistrarEventsCreate(extractRegistrarEventsCreate(migrationFunction))).toBe(
    normalizeRegistrarEventsCreate(extractRegistrarEventsCreate(schemaBlock)),
  );
});

test("migrate() rebuilds v41 registrar_events with foreign_keys ON and preserves self-references", () => {
  const db = makeV41Db();
  db.run("PRAGMA foreign_keys = ON");
  db.run(
    `INSERT INTO registrar_events
       (event_id, registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
     VALUES (3, 'registrar-1', NULL, 'blocker', 'opened', NULL, NULL, NULL, 'maestro', 'blocker', 102)`,
  );
  db.run(
    `INSERT INTO registrar_events
       (event_id, registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
     VALUES (4, 'registrar-1', NULL, 'blocker', 'resolved', 3, NULL, NULL, 'maestro', 'resolved blocker', 103)`,
  );

  migrate(db, { embeddingDim: 384 });

  expect(
    db
      .query<
        { event_id: number; ref_event_id: number | null },
        []
      >("SELECT event_id, ref_event_id FROM registrar_events WHERE event_id IN (3, 4) ORDER BY event_id")
      .all(),
  ).toEqual([
    { event_id: 3, ref_event_id: null },
    { event_id: 4, ref_event_id: 3 },
  ]);
  expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
});

test("SCHEMA_VERSION is 45", () => {
  expect(SCHEMA_VERSION).toBe(45);
});
