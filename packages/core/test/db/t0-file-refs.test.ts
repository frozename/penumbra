import { Database } from "bun:sqlite";
// packages/core/test/db/t0-file-refs.test.ts
import { describe, expect, test } from "bun:test";

import { migrate } from "../../src/db/migrations.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
// macOS preamble (see Pre-flight "Test file boilerplate")
try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {
  // platform-specific SQLite override; ignore failures elsewhere
}

describe("t0_file_refs trigger", () => {
  test("Edit/Write/Read tool calls produce one row per file_path in payload", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const editPayload = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "packages/core/src/db/schema.ts" },
    });
    db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, payload_json)
       VALUES ('e1', '2026-05-03', '2026-05-03', 'claude-code', 'u', 'm', 'tool_use', 'tool', ?)`,
      [editPayload],
    );
    const refs = db
      .query<
        { event_id: string; file_path: string },
        []
      >(`SELECT event_id, file_path FROM t0_file_refs`)
      .all();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ event_id: "e1", file_path: "packages/core/src/db/schema.ts" });
  });

  test("events without file_path produce no rows", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, payload_json)
       VALUES ('e2', '2026-05-03', '2026-05-03', 'claude-code', 'u', 'm', 'agent_thought', 'thought', '{"text":"thinking"}')`,
    );
    const count = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t0_file_refs`).get();
    expect(count?.c).toBe(0);
  });
});
