import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { applySchema } from "../../src/db/schema.js";

test("sqlite foreign keys cascade verification events when a memory is deleted", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);

  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids,
      window_start, window_end, title, body, metadata_json,
      compressed_from, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "memory-fk",
      null,
      "u1",
      "fact",
      "[]",
      "2026-05-12T12:00:00.000Z",
      "2026-05-12T12:00:00.000Z",
      "memory-fk",
      "body",
      "{}",
      null,
      "2026-05-12T12:00:00.000Z",
      "2026-05-12T12:00:00.000Z",
    ],
  );
  db.run(
    `INSERT INTO t2_memory_verification_events(
      event_id, memory_id, verifier_actor, claimed_by, reason, session_id, verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["evt-fk", "memory-fk", "machine-1", "maestro", "manual", "sess-1", "2026-05-12T12:01:00.000Z"],
  );

  db.run(`DELETE FROM t2_memories WHERE memory_id = ?`, ["memory-fk"]);

  const remaining = db
    .query<
      { c: number },
      []
    >(`SELECT COUNT(*) AS c FROM t2_memory_verification_events WHERE memory_id = 'memory-fk'`)
    .get();
  expect(remaining?.c).toBe(0);
});
