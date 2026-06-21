import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { loadSqliteVec } from "../../src/db/sqlite-vec.js";

// On macOS, Bun uses the Apple SQLite build which disables extension loading.
// Switch to Homebrew's full-featured SQLite before any Database is created.
// See: https://bun.sh/docs/api/sqlite#loadextension
// Guard: setCustomSQLite throws if called after SQLite is already loaded (e.g.
// when multiple test files in the same bun test run each attempt the call).
if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded by a sibling test file — no-op
  }
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
});
afterEach(() => {
  db.close();
});

test("loadSqliteVec enables vec0 virtual tables", () => {
  loadSqliteVec(db);
  db.run("CREATE VIRTUAL TABLE v USING vec0(embedding FLOAT[4])");
  const rows = db.query("SELECT name FROM sqlite_master WHERE type=?").all("table");
  expect(rows.length).toBeGreaterThanOrEqual(1);
});

test("can insert and query a vector", () => {
  loadSqliteVec(db);
  db.run("CREATE VIRTUAL TABLE v USING vec0(embedding FLOAT[4])");
  db.run("INSERT INTO v(rowid, embedding) VALUES (?, ?)", [
    1,
    new Float32Array([0.1, 0.2, 0.3, 0.4]),
  ]);
  const rows = db.query("SELECT rowid FROM v").all() as { rowid: number }[];
  expect(rows[0]?.rowid).toBe(1);
});
