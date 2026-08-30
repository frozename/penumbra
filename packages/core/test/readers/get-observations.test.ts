import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { migrate } from "../../src/db/migrations.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { getObservations } from "../../src/readers/get-observations.js";

const MS_PER_DAY = 86_400_000;

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

describe("getObservations", () => {
  test("hydrates t2 rows by id with all known fields", () => {
    const db = freshDb();
    const observedAt = new Date(Date.now() - 7 * MS_PER_DAY).toISOString();
    db.run(
      `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids,
                               window_start, window_end, title, body, metadata_json,
                               created_at, updated_at, last_verified_at, last_verified_by,
                               last_verified_reason, last_verified_session_id, obs_type, concepts, file_paths)
       VALUES ('m1', 'u', 'rollup', '[]', ?, ?, 't', 'b', '{}',
               ?, ?, ?, 'maestro',
               'spot check', 'sess-1', 'feature', '["acp"]', '["agentchat.yaml"]')`,
      [observedAt, observedAt, observedAt, observedAt, observedAt],
    );
    const out = getObservations(db, { ids: ["m1", "missing"] });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("m1");
    expect(out[0]!.obs_type).toBe("feature");
    expect(out[0]!).toMatchObject({
      last_verified_at: observedAt,
      last_verified_by: "maestro",
      last_verified_reason: "spot check",
      last_verified_session_id: "sess-1",
    });
    expect(out[0]!.stale).toBe(false);
    expect(out[0]!.concepts).toEqual(["acp"]);
    expect(out[0]!.file_paths).toEqual(["agentchat.yaml"]);
  });

  test("surfaces freshness metadata for fresh and stale observations", () => {
    const db = freshDb();
    const now = Date.now();
    const freshCreatedAt = new Date(now - 3 * 86_400_000).toISOString();
    const staleCreatedAt = new Date(now - 200 * 86_400_000).toISOString();

    db.run(
      `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids,
                               window_start, window_end, title, body, metadata_json,
                               created_at, updated_at, last_verified_at, obs_type, concepts, file_paths)
       VALUES ('fresh', 'u', 'rollup', '[]', ?, ?, 'fresh', 'body', '{}',
               ?, ?, ?, 'feature', '[]', '[]')`,
      [freshCreatedAt, freshCreatedAt, freshCreatedAt, freshCreatedAt, freshCreatedAt],
    );
    db.run(
      `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids,
                               window_start, window_end, title, body, metadata_json,
                               created_at, updated_at, obs_type, concepts, file_paths)
       VALUES ('stale', 'u', 'rollup', '[]', ?, ?, 'stale', 'body', '{}',
               ?, ?, 'decision', '[]', '[]')`,
      [staleCreatedAt, staleCreatedAt, staleCreatedAt, staleCreatedAt],
    );

    const out = getObservations(db, { ids: ["fresh", "stale"] });
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe("fresh");
    expect(out[0]?.stale).toBe(false);
    expect(typeof out[0]?.age_days).toBe("number");
    expect(out[1]?.id).toBe("stale");
    expect(out[1]?.stale).toBe(true);
    expect(typeof out[1]?.age_days).toBe("number");
  });

  test("respects requested order", () => {
    const db = freshDb();
    const observedAt = new Date(Date.now() - 7 * MS_PER_DAY).toISOString();
    const insert = (id: string): void => {
      db.run(
        `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids,
                                 window_start, window_end, title, body, metadata_json,
                                 created_at, updated_at)
         VALUES (?, 'u', 'rollup', '[]', ?, ?, '', '', '{}',
                 ?, ?)`,
        [id, observedAt, observedAt, observedAt, observedAt],
      );
    };
    insert("a");
    insert("b");
    insert("c");
    const out = getObservations(db, { ids: ["c", "a", "b"] });
    expect(out.map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(out.every((r) => r.stale === false)).toBe(true);
  });

  test("empty ids array returns []", () => {
    const db = freshDb();
    const out = getObservations(db, { ids: [] });
    expect(out).toEqual([]);
  });
});
