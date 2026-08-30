import { Database } from "bun:sqlite";
// packages/core/test/db/schema-recall-fields.test.ts
import { describe, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

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
  migrate(db, { embeddingDim: 4 });
  return db;
}

describe("recall schema enrichment", () => {
  test("t2_memories carries first-class obs_type, concepts, severity", () => {
    const db = freshDb();
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(t2_memories)`)
      .all()
      .map((r) => r.name);
    expect(cols).toContain("obs_type");
    expect(cols).toContain("concepts");
    expect(cols).toContain("severity");
    expect(cols).toContain("file_paths");
  });

  test("t1_fts and t2_fts virtual tables exist", () => {
    const db = freshDb();
    const t1 = db
      .query<
        { name: string },
        [string]
      >(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get("t1_fts");
    const t2 = db
      .query<
        { name: string },
        [string]
      >(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get("t2_fts");
    expect(t1?.name).toBe("t1_fts");
    expect(t2?.name).toBe("t2_fts");
  });

  test("idx_t2_obs_type and idx_t2_severity exist", () => {
    const db = freshDb();
    const idx = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='t2_memories'`,
      )
      .all()
      .map((r) => r.name);
    expect(idx).toContain("idx_t2_obs_type");
    expect(idx).toContain("idx_t2_severity");
  });
});
