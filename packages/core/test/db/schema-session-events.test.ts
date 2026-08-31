import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

describe("session_events table", () => {
  test("applySchema creates session_events with 5 indexes", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const cols = db.query("PRAGMA table_info('session_events')").all() as {
      name: string;
      notnull: number;
    }[];
    expect(cols.map((c) => c.name).sort()).toEqual([
      "cwd",
      "id",
      "kind",
      "meta_json",
      "project_id",
      "ref_path",
      "related_session_id",
      "session_id",
      "transcript_path",
      "ts",
    ]);

    const notnull = Object.fromEntries(cols.map((c) => [c.name, c.notnull === 1]));
    expect(notnull.session_id).toBe(false);
    expect(notnull.kind).toBe(true);
    expect(notnull.ts).toBe(true);
    expect(notnull.related_session_id).toBe(false);
    expect(notnull.project_id).toBe(false);
    expect(notnull.cwd).toBe(false);
    expect(notnull.transcript_path).toBe(false);
    expect(notnull.ref_path).toBe(false);
    expect(notnull.meta_json).toBe(false);

    const indexes = db.query("PRAGMA index_list('session_events')").all() as {
      name: string;
    }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_session_events_session");
    expect(names).toContain("idx_session_events_kind_ts");
    expect(names).toContain("idx_session_events_ref");
    expect(names).toContain("idx_session_events_related");
    expect(names).toContain("idx_session_events_ts");
    expect(names).toHaveLength(5);
    db.close();
  });

  test("retention-shaped session_events query uses a range seek", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const plan = db
      .query<{ detail: string }, [string, number]>(
        `EXPLAIN QUERY PLAN
         SELECT id FROM session_events
         WHERE ts < ?
         ORDER BY ts ASC, id ASC
         LIMIT ?`,
      )
      .all("2026-05-01T00:00:00.000Z", 1000);
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_session_events_ts");
    expect(details).not.toContain("SCAN session_events");
    db.close();
  });

  test("an oversized meta_json is rejected by the CHECK", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    expect(() => {
      db.run(
        `INSERT INTO session_events (session_id, kind, ts, meta_json)
         VALUES ('s1', 'session.start', '2026-05-01T00:00:00.000Z', ?)`,
        ["x".repeat(8193)],
      );
    }).toThrow(/CHECK/);
    db.close();
  });
});
