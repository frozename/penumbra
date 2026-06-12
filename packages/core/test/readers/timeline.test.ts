import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { migrate } from "../../src/db/migrations.js";
import { timeline } from "../../src/readers/timeline.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function freshDb() {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 4 });
  return db;
}

function insertT2(db: Database, id: string, ts: string, project: string | null = null): void {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                             window_start, window_end, title, body, metadata_json,
                             created_at, updated_at)
     VALUES (?, ?, 'u', 'rollup', '[]', ?, ?, ?, '', '{}', ?, ?)`,
    [id, project, ts, ts, id, ts, ts],
  );
}

function insertT2WithVerifiedAt(
  db: Database,
  id: string,
  ts: string,
  lastVerifiedAt: string | null,
): void {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                             window_start, window_end, title, body, metadata_json,
                             created_at, updated_at, last_verified_at)
     VALUES (?, NULL, 'u', 'rollup', '[]', ?, ?, ?, '', '{}', ?, ?, ?)`,
    [id, ts, ts, id, ts, ts, lastVerifiedAt],
  );
}

describe("timeline (chronological neighbors)", () => {
  test("returns depth_before earlier and depth_after later memories around an anchor", () => {
    const db = freshDb();
    insertT2(db, "m1", "2026-05-01T00:00:00Z");
    insertT2(db, "m2", "2026-05-02T00:00:00Z");
    insertT2(db, "m3", "2026-05-03T00:00:00Z");
    insertT2(db, "m4", "2026-05-04T00:00:00Z");
    insertT2(db, "m5", "2026-05-05T00:00:00Z");
    const out = timeline(db, { anchor: "m3", depth_before: 1, depth_after: 2 });
    expect(out.map((r) => r.id)).toEqual(["m2", "m3", "m4", "m5"]);
  });

  test("project_id filter applies before slicing the window", () => {
    const db = freshDb();
    insertT2(db, "a", "2026-05-01T00:00:00Z", "penumbra");
    insertT2(db, "b", "2026-05-02T00:00:00Z", "other");
    insertT2(db, "c", "2026-05-03T00:00:00Z", "penumbra");
    const out = timeline(db, {
      anchor: "c",
      depth_before: 5,
      depth_after: 0,
      project_id: "penumbra",
    });
    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
  });

  test("missing anchor returns []", () => {
    const db = freshDb();
    const out = timeline(db, { anchor: "does-not-exist", depth_before: 3, depth_after: 3 });
    expect(out).toEqual([]);
  });

  test("surfaces freshness metadata on timeline entries", () => {
    const db = freshDb();
    const now = new Date();
    const anchorCreatedAt = new Date(now.getTime() - 1 * 86_400_000).toISOString();
    const freshCreatedAt = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
    const staleCreatedAt = new Date(now.getTime() - 200 * 86_400_000).toISOString();

    insertT2WithVerifiedAt(db, "fresh", freshCreatedAt, freshCreatedAt);
    insertT2(db, "anchor", anchorCreatedAt);
    insertT2WithVerifiedAt(db, "stale", staleCreatedAt, null);

    const out = timeline(db, { anchor: "anchor", depth_before: 1, depth_after: 1 });
    expect(out).toHaveLength(3);
    expect(out).toContainEqual(
      expect.objectContaining({
        id: "fresh",
        age_days: expect.any(Number),
        stale: false,
      }),
    );
    expect(out).toContainEqual(
      expect.objectContaining({
        id: "anchor",
        age_days: expect.any(Number),
        stale: false,
      }),
    );
    expect(out).toContainEqual(
      expect.objectContaining({
        id: "stale",
        age_days: expect.any(Number),
        stale: true,
      }),
    );
  });
});
