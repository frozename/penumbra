import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { applySchema, SCHEMA_VERSION } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

import snapshot from "./fixtures/schema-snapshot.json";

// See schema.test.ts — macOS Bun ships an SQLite without extension loading.
if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded by a sibling test file — no-op
  }
}

interface SchemaSnapshot {
  schemaVersion: number;
  tables: Record<string, string[]>;
  indexes: string[];
  views: string[];
  triggers: string[];
}

function dumpSchema(db: Database): SchemaSnapshot {
  const objects = db
    .query<
      { name: string; type: string },
      []
    >("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all();
  const tables: Record<string, string[]> = {};
  for (const obj of objects.filter((o) => o.type === "table")) {
    tables[obj.name] = db
      .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?) ORDER BY name")
      .all(obj.name)
      .map((r) => r.name);
  }
  const namesOfType = (type: string): string[] =>
    objects.filter((o) => o.type === type).map((o) => o.name);
  return {
    schemaVersion: SCHEMA_VERSION,
    tables,
    indexes: namesOfType("index"),
    views: namesOfType("view"),
    triggers: namesOfType("trigger"),
  };
}

const FIXTURE_PATH = "packages/core/test/db/fixtures/schema-snapshot.json";

test("a fresh applySchema database matches the committed schema snapshot", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  const actual = dumpSchema(db);

  if (process.env.PENUMBRA_UPDATE_SCHEMA_SNAPSHOT === "1") {
    await Bun.write(FIXTURE_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }

  const expected = snapshot as SchemaSnapshot;
  // A drift here means the programmatic schema changed: bump SCHEMA_VERSION,
  // add the matching addColumnIfMissing/CREATE ... IF NOT EXISTS upgrade path
  // for legacy databases, then refresh the fixture with
  // PENUMBRA_UPDATE_SCHEMA_SNAPSHOT=1 bun test packages/core/test/db/schema-snapshot.test.ts
  expect(actual.schemaVersion).toBe(expected.schemaVersion);
  expect(Object.keys(actual.tables).sort()).toEqual(Object.keys(expected.tables).sort());
  for (const [table, columns] of Object.entries(expected.tables)) {
    expect(actual.tables[table]).toEqual(columns);
  }
  expect(actual.indexes).toEqual(expected.indexes);
  expect(actual.views).toEqual(expected.views);
  expect(actual.triggers).toEqual(expected.triggers);
});
