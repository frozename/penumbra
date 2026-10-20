import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { SCHEMA_VERSION } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // A sibling test may have already loaded SQLite.
  }
}

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function migratedDb(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function stampedVersion(db: Database): string | undefined {
  return db
    .query<{ value: string }, []>("SELECT value FROM db_meta WHERE key = 'schema_version'")
    .get()?.value;
}

function conversationIndexSql(db: Database): string | undefined {
  return db
    .query<
      { sql: string },
      []
    >("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'agent_perf_by_conversation'")
    .get()?.sql;
}

function insertPerformanceRow(db: Database, id: string, conversationId: string | null): void {
  db.prepare(
    `INSERT INTO agent_performance (performance_id, ts, handoff_id, conversation_id, agent_name, task_type, outcome, source, cost_usd)
     VALUES (?, '2026-10-20T00:00:00.000Z', ?, ?, 'agent', 'health_check', 'merged', 'worker', 0.01)`,
  ).run(id, id, conversationId);
}

test("the conversation index leaves NULL-conversation tick rows out", () => {
  expect(conversationIndexSql(migratedDb())).toMatch(/WHERE\s+conversation_id IS NOT NULL$/);
});

test("a store stamped at the current version gains the conversation index on startup without a version bump", () => {
  const db = migratedDb();
  db.run("DROP INDEX IF EXISTS agent_perf_by_conversation");
  insertPerformanceRow(db, "p-chain", "chain-1");
  insertPerformanceRow(db, "p-tick", null);
  expect(conversationIndexSql(db)).toBeUndefined();
  expect(stampedVersion(db)).toBe(String(SCHEMA_VERSION));

  migrate(db, { embeddingDim: 384 });

  expect(conversationIndexSql(db)).toBeDefined();
  expect(stampedVersion(db)).toBe(String(SCHEMA_VERSION));
});
