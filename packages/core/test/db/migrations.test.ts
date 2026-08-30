import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

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

test("migrate applies schema and records version on a fresh db", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const v = db
    .query<{ value: string }, [string]>("SELECT value FROM db_meta WHERE key=?")
    .get("schema_version");
  expect(v?.value).toBe(String(SCHEMA_VERSION));
});

test("migrate is idempotent", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  migrate(db, { embeddingDim: 384 });
  const tables = db
    .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type=?")
    .all("table").length;
  expect(tables).toBeGreaterThan(5);
});

test("migrate rejects a mismatched embedding dim on a non-empty db", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  expect(() => {
    migrate(db, { embeddingDim: 1536 });
  }).toThrow(/embedding_dim/);
});

test("migrate backfills legacy t2_memory_verification_events columns and index", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  db.run(`
    CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE t2_memories (
      memory_id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_session_ids TEXT NOT NULL DEFAULT '[]',
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      compressed_from TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE t2_memory_verification_events (
      event_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      verifier_actor TEXT NOT NULL,
      claimed_by TEXT,
      reason TEXT,
      session_id TEXT,
      verified_at TEXT NOT NULL
    );
  `);

  migrate(db, { embeddingDim: 384 });

  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info(t2_memory_verification_events)`)
    .all()
    .map((row) => row.name);
  expect(cols).toContain("basis");
  expect(cols).toContain("basis_type");
  expect(cols).toContain("basis_detail");

  const idx = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='t2_memory_verification_events'`,
    )
    .all()
    .map((row) => row.name);
  expect(idx).toContain("t2_memory_verification_events_basis_type");
});

test("migrate creates long_lived_pending_actions.meta_json", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const row = db
    .query<{ name: string; type: string; notnull: number }, []>(
      "PRAGMA table_info('long_lived_pending_actions')",
    )
    .all()
    .find((column) => column.name === "meta_json");
  expect(row).toBeDefined();
  expect(row?.name).toBe("meta_json");
  expect(row?.type).toBe("TEXT");
  expect(row?.notnull).toBe(0);
});
