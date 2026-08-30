import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { HandoffReader } from "@src/readers/handoff.js";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {
  // already loaded in this process
}

let db: Database;
let reader: HandoffReader;

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  reader = new HandoffReader({ db });
});

function insertHandoff(id: string, parent: string | null): void {
  db.prepare(
    `
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, parent_handoff_id)
    VALUES (?, datetime('now'), 'c', 'a', 'b', 'm', 'pending', ?)
  `,
  ).run(id, parent);
}

test("getSpawnDepth returns 0 for root handoff (no parent)", () => {
  insertHandoff("h-root", null);
  expect(reader.getSpawnDepth("h-root")).toBe(0);
});

test("getSpawnDepth returns 1 for direct child", () => {
  insertHandoff("h-root", null);
  insertHandoff("h-child", "h-root");
  expect(reader.getSpawnDepth("h-child")).toBe(1);
});

test("getSpawnDepth returns N for N-deep chain", () => {
  insertHandoff("h-0", null);
  insertHandoff("h-1", "h-0");
  insertHandoff("h-2", "h-1");
  insertHandoff("h-3", "h-2");
  expect(reader.getSpawnDepth("h-3")).toBe(3);
});

test("getSpawnDepth returns 0 for unknown handoff_id", () => {
  expect(reader.getSpawnDepth("nonexistent")).toBe(0);
});

test("getSpawnDepth caps at sanity limit on cycle", () => {
  // Force a cycle by writing a parent that points to self
  insertHandoff("h-cycle", "h-cycle");
  // Should return the sanity cap (64), not infinite loop
  expect(reader.getSpawnDepth("h-cycle")).toBeGreaterThanOrEqual(64);
});

test("getSpawnDepth returns 1 when intermediate row vanishes", () => {
  // Edge: parent_handoff_id points to a row that no longer exists.
  // Walk counts the one valid hop (h-orphan exists with parent set) and stops
  // when the next lookup yields no row, rather than looping forever.
  insertHandoff("h-orphan", "h-missing");
  expect(reader.getSpawnDepth("h-orphan")).toBe(1);
});
