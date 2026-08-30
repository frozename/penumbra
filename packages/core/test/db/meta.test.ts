import { DbMeta } from "@src/db/meta.js";
import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

// On macOS, Bun uses the Apple SQLite build which disables extension loading.
// Switch to Homebrew's full-featured SQLite before any Database is created.
// See: https://bun.sh/docs/api/sqlite#loadextension
// Guard: setCustomSQLite throws if called after SQLite is already loaded (e.g.
// when multiple test files in the same bun test run each attempt the call).
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
});

test("set and get roundtrip", () => {
  const m = new DbMeta(db);
  m.set("embedder_name", "minilm");
  expect(m.get("embedder_name")).toBe("minilm");
});

test("get returns undefined for missing key", () => {
  const m = new DbMeta(db);
  expect(m.get("nope")).toBeUndefined();
});

test("set overwrites existing value", () => {
  const m = new DbMeta(db);
  m.set("k", "v1");
  m.set("k", "v2");
  expect(m.get("k")).toBe("v2");
});

test("getNumber parses and returns typed values", () => {
  const m = new DbMeta(db);
  m.set("dim", "384");
  expect(m.getNumber("dim")).toBe(384);
  expect(m.getNumber("missing")).toBeUndefined();
});
