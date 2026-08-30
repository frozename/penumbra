import { backfillRecallFields } from "@src/db/backfill-recall-fields.js";
import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

// Switch to Homebrew's full-featured SQLite before any Database is created.
// Guard against double-load when multiple test files run in the same process.
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

describe("backfillRecallFields", () => {
  test("emoji-prefixed titles map to obs_type", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const samples = [
      ["🔴 Bug in foo", "bugfix"],
      ["🟣 New feature bar", "feature"],
      ["🔄 Refactor baz", "refactor"],
      ["✅ Updated quux", "change"],
      ["🔵 Discovery about ACP", "discovery"],
      ["⚖️ Decided on RRF", "decision"],
      ["🚨 Credential leak audit", "security_alert"],
      ["🔐 Hardened gemini-acp env", "security_note"],
      ["🎯 Session continuation", "session"],
      ["No prefix at all", null],
    ];
    let i = 0;
    for (const [title] of samples) {
      db.run(
        `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at)
         VALUES (?, 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', ?, '', '{}', '2026-05-03', '2026-05-03')`,
        [`m${String(i++)}`, title],
      );
    }

    const stats = backfillRecallFields(db);
    expect(stats.t2_obs_type_set).toBe(samples.filter((s) => s[1] !== null).length);

    const rows = db
      .query<
        { memory_id: string; obs_type: string | null },
        []
      >(`SELECT memory_id, obs_type FROM t2_memories ORDER BY memory_id`)
      .all();
    expect(rows.map((r) => r.obs_type)).toEqual(samples.map((s) => s[1]));
  });

  test("metadata_json.concepts[] is hoisted into concepts column", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    db.run(
      `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at)
       VALUES ('m1', 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', '✅ x', 'b', ?, '2026-05-03', '2026-05-03')`,
      [JSON.stringify({ concepts: ["acp", "codex"] })],
    );
    backfillRecallFields(db);
    const row = db
      .query<{ concepts: string }, []>(`SELECT concepts FROM t2_memories WHERE memory_id='m1'`)
      .get();
    expect(JSON.parse(row!.concepts)).toEqual(["acp", "codex"]);
  });

  test("is idempotent — second run does not flip already-set fields", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    db.run(
      `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type)
       VALUES ('m1', 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', '✅ x', 'b', '{}', '2026-05-03', '2026-05-03', 'feature')`,
    );
    const first = backfillRecallFields(db);
    const second = backfillRecallFields(db);
    expect(first.t2_obs_type_set).toBe(0); // already set; emoji says 'change' but obs_type='feature' wins
    expect(second.t2_obs_type_set).toBe(0);
    const row = db
      .query<{ obs_type: string }, []>(`SELECT obs_type FROM t2_memories WHERE memory_id='m1'`)
      .get();
    expect(row?.obs_type).toBe("feature");
  });
});
