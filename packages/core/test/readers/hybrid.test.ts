// packages/core/test/readers/hybrid.test.ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {}
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { migrate } from "../../src/db/migrations.js";
import { hybridSearch } from "../../src/readers/hybrid.js";
import { TestEmbedder } from "../../src/embedder/test-embedder.js";

describe("hybridSearch", () => {
  test("metadata pre-filter narrows the candidate set before vector rerank", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const insert = (id: string, type: string, body: string, vec: number[]) => {
      db.run(
        `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type)
         VALUES (?, 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', ?, ?, '{}', '2026-05-03', '2026-05-03', ?)`,
        [id, body, body, type],
      );
      const rowid = db
        .query<{ rowid: number }, [string]>(`SELECT rowid FROM t2_memories WHERE memory_id=?`)
        .get(id)!.rowid;
      db.run(`INSERT INTO t2_vec(rowid, embedding) VALUES (?, ?)`, [rowid, new Float32Array(vec)]);
    };
    insert("a", "bugfix", "apple pie", [1, 0, 0, 0]);
    insert("b", "feature", "apple cart", [0.9, 0, 0, 0]);
    insert("c", "bugfix", "banana split", [0, 1, 0, 0]);

    const out = await hybridSearch(db, new TestEmbedder({ dim: 4 }), {
      query: "apple",
      obs_type: "bugfix",
      limit: 5,
    });
    // obs_type='bugfix' excludes 'b' from the candidate set entirely.
    // Both 'a' and 'c' are bugfixes, so both survive into the vector rerank.
    const ids = out.map((h) => h.id).sort();
    expect(ids).toEqual(["a", "c"]);
    expect(out.find((h) => h.id === "b")).toBeUndefined();
  });

  test("retired t2 memories are excluded from candidates", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const insert = (id: string, body: string, vec: number[]) => {
      db.run(
        `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type)
         VALUES (?, 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', ?, ?, '{}', '2026-05-03', '2026-05-03', 'feature')`,
        [id, body, body],
      );
      const rowid = db
        .query<{ rowid: number }, [string]>(`SELECT rowid FROM t2_memories WHERE memory_id=?`)
        .get(id)!.rowid;
      db.run(`INSERT INTO t2_vec(rowid, embedding) VALUES (?, ?)`, [rowid, new Float32Array(vec)]);
    };
    insert("active1", "apple pie", [1, 0, 0, 0]);
    insert("active2", "apple jam", [0.95, 0, 0, 0]);
    insert("retired", "apple cart", [0.9, 0, 0, 0]);
    db.run("UPDATE t2_memories SET retired_at = ? WHERE memory_id = 'retired'", [Date.now()]);

    const out = await hybridSearch(db, new TestEmbedder({ dim: 4 }), { query: "apple", limit: 5 });
    const ids = out.map((h) => h.id).sort();
    expect(ids).toEqual(["active1", "active2"]);
    expect(out.find((h) => h.id === "retired")).toBeUndefined();
  });
});
