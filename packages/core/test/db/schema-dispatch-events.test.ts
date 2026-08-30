import { DispatchEventKindSchema } from "@penumbra/api-contract";
import { applySchema, SCHEMA_VERSION } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

describe("dispatch_events table", () => {
  test("SCHEMA_VERSION is bumped for dispatch event storage", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
  });

  test("api contract includes lane override audit events", () => {
    expect(DispatchEventKindSchema.safeParse("lane.override").success).toBe(true);
  });

  test("applySchema creates dispatch_events with expected columns and indexes", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    const cols = db.query("PRAGMA table_info('dispatch_events')").all() as {
      name: string;
      notnull: number;
    }[];
    expect(cols.map((c) => c.name).sort()).toEqual([
      "handoff_id",
      "id",
      "kind",
      "meta_json",
      "source",
      "ts",
      "worker_id",
    ]);
    const notnull = Object.fromEntries(cols.map((c) => [c.name, c.notnull === 1]));
    expect(notnull.handoff_id).toBe(true);
    expect(notnull.source).toBe(true);
    expect(notnull.kind).toBe(true);
    expect(notnull.ts).toBe(true);
    expect(notnull.worker_id).toBe(false);
    expect(notnull.meta_json).toBe(false);

    const indexes = db.query("PRAGMA index_list('dispatch_events')").all() as {
      name: string;
    }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_dispatch_events_handoff");
    expect(names).toContain("idx_dispatch_events_ts");
    db.close();
  });

  test("meta_json check constraint rejects payloads larger than 4 KB", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);

    expect(() => {
      db.run(
        `INSERT INTO dispatch_events (handoff_id, source, kind, ts, meta_json)
         VALUES ('h', 'worker', 'dispatch.start', '2026-05-01T00:00:00.000Z', ?)`,
        ["x".repeat(5000)],
      );
    }).toThrow(/CHECK/);
    db.close();
  });
});
