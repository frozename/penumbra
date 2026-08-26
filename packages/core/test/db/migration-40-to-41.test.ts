import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { migrate } from "../../src/db/migrations.js";
import { SCHEMA_VERSION } from "../../src/db/schema.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

function makeV40Db(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.run("DROP TABLE IF EXISTS registrar_events");
  db.run("DROP TABLE IF EXISTS registrar_phases");
  db.run("DROP TABLE IF EXISTS registrar_entries");
  db.run("UPDATE db_meta SET value = '40' WHERE key = 'schema_version'");
  return db;
}

test("migrate() adds the three registrar tables to a v40 database without touching existing plans rows", () => {
  const db = makeV40Db();
  db.run(
    `INSERT INTO plans(plan_id, file_path, home_project, registered_at, status)
     VALUES (?, ?, ?, ?, ?)`,
    ["legacy-plan", "/tmp/legacy.md", "penumbra", 1_700_000_000, "running"],
  );
  const before = db.query("SELECT * FROM plans WHERE plan_id = 'legacy-plan'").get();

  migrate(db, { embeddingDim: 384 });

  const tables = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'registrar_%'
       ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
  expect(tables).toEqual(["registrar_entries", "registrar_events", "registrar_phases"]);
  expect(db.query("SELECT * FROM plans WHERE plan_id = 'legacy-plan'").get()).toEqual(before);
});

test("SCHEMA_VERSION is 41", () => {
  expect(SCHEMA_VERSION).toBe(41);
});
