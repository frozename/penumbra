import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { backfillRecallFields } from "@src/db/backfill-recall-fields.js";
import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { TestEmbedder } from "@src/embedder/test-embedder.js";
import { RecallReader } from "@src/readers/recall.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

describe("memory schema enrichment", () => {
  test("adds additive t2 memory fields, backfills learned_at, and remains idempotent", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);

    db.run(`
      CREATE TABLE IF NOT EXISTS t2_memories (
        memory_id           TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL,
        project_id          TEXT,
        kind                TEXT NOT NULL,
        slug                TEXT,
        hook                TEXT,
        sub_kind            TEXT,
        cc_kind             TEXT,
        source_session_ids  TEXT NOT NULL DEFAULT '[]',
        window_start        TEXT NOT NULL,
        window_end          TEXT NOT NULL,
        title               TEXT NOT NULL,
        body                TEXT NOT NULL,
        metadata_json       TEXT NOT NULL DEFAULT '{}',
        concepts            TEXT,
        severity            TEXT,
        file_paths          TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        embedding_model_version TEXT,
        retired_at          INTEGER,
        origin              TEXT,
        obs_type            TEXT,
        last_verified_at    TEXT,
        last_verified_by    TEXT,
        last_verified_actor TEXT,
        last_verified_reason TEXT,
        last_verified_session_id TEXT
      );
    `);

    const rows = [
      {
        id: "m1",
        title: "Legacy memory 1",
        body: "alpha",
        createdAt: "2026-05-01T00:00:00Z",
      },
      {
        id: "m2",
        title: "Legacy memory 2",
        body: "beta",
        createdAt: "2026-05-02T00:00:00Z",
      },
      {
        id: "m3",
        title: "Legacy memory 3",
        body: "gamma",
        createdAt: "2026-05-03T00:00:00Z",
      },
    ];

    for (const row of rows) {
      db.run(
        `INSERT INTO t2_memories(memory_id, user_id, project_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at)
         VALUES (?, 'u', 'p1', 'rollup', '[]', ?, ?, ?, ?, '{}', ?, ?)`,
        [row.id, row.createdAt, row.createdAt, row.title, row.body, row.createdAt, row.createdAt],
      );
    }

    migrate(db, { embeddingDim: 4 });
    const embedder = new TestEmbedder({ dim: 4 });
    for (const row of rows) {
      const [vec] = await embedder.embed([row.body]);
      const rowid = db
        .query<{ rowid: number }, [string]>("SELECT rowid FROM t2_memories WHERE memory_id=?")
        .get(row.id)!.rowid;
      db.run("INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)", [rowid, vec!]);
    }

    const firstRun = backfillRecallFields(db);

    const info = db
      .query<{ name: string; type: string }, []>(`PRAGMA table_info(t2_memories)`)
      .all();
    const names = info.map((r) => r.name);
    expect(names).toContain("why");
    expect(names).toContain("source_quote");
    expect(names).toContain("learned_at");
    expect(names).toContain("durability");
    expect(names).toContain("depth");
    expect(names).toContain("is_episodic");
    expect(names).toContain("decay_score");
    expect(names).toContain("decay_scored_at");
    expect(names).toContain("archived_at");

    const archivedAt = info.find((r) => r.name === "archived_at");
    expect(archivedAt?.type).toBe("TEXT");

    const firstRows = db
      .query<
        {
          memory_id: string;
          created_at: string;
          learned_at: string | null;
          durability: string | null;
          depth: number | null;
          is_episodic: number;
        },
        []
      >(
        `SELECT memory_id, created_at, learned_at, durability, depth, is_episodic
         FROM t2_memories
         ORDER BY memory_id`,
      )
      .all();

    expect(firstRows).toHaveLength(3);
    for (const row of firstRows) {
      expect(row.learned_at).toBe(row.created_at);
      expect(row.durability).toBeNull();
      expect(row.depth).toBeNull();
      expect(row.is_episodic).toBe(0);
    }

    const beforeSecond = db
      .query<
        {
          memory_id: string;
          learned_at: string | null;
          durability: string | null;
          depth: number | null;
          is_episodic: number;
        },
        []
      >(
        `SELECT memory_id, learned_at, durability, depth, is_episodic
         FROM t2_memories
         ORDER BY memory_id`,
      )
      .all();
    const beforeSecondCount = db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memories`)
      .get()?.c;

    migrate(db, { embeddingDim: 4 });
    const secondRun = backfillRecallFields(db);

    const afterSecond = db
      .query<
        {
          memory_id: string;
          learned_at: string | null;
          durability: string | null;
          depth: number | null;
          is_episodic: number;
        },
        []
      >(
        `SELECT memory_id, learned_at, durability, depth, is_episodic
         FROM t2_memories
         ORDER BY memory_id`,
      )
      .all();
    const afterSecondCount = db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memories`)
      .get()?.c;

    expect(firstRun.t2_learned_at_set).toBe(3);
    expect(secondRun.t2_learned_at_set).toBe(0);
    expect(afterSecond).toEqual(beforeSecond);
    expect(beforeSecondCount).toBe(3);
    expect(afterSecondCount).toBe(3);

    const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 4 }) });
    const results = await reader.recall({
      query: "alpha beta gamma",
      project_id: "p1",
      limit: 10,
      include_raw: false,
      min_score: 0,
    });

    expect(results.map((r) => r.id).sort()).toEqual(["m1", "m2", "m3"]);
  });
});
