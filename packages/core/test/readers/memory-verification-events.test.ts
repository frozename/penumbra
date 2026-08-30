import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { getMemoryVerificationEvents } from "@src/readers/memory-verification-events.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("getMemoryVerificationEvents clamps limit to a bounded range", () => {
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
      "memory-limit",
      null,
      "u1",
      "fact",
      "[]",
      "2026-05-12T12:00:00.000Z",
      "2026-05-12T12:00:00.000Z",
      "memory-limit",
      "body",
      "{}",
      null,
      "2026-05-12T12:00:00.000Z",
      "2026-05-12T12:00:00.000Z",
    ],
  );

  for (let i = 0; i < 3; i++) {
    db.run(
      `INSERT INTO t2_memory_verification_events(
        event_id, memory_id, verifier_actor, claimed_by, reason, session_id, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        `evt-${String(i)}`,
        "memory-limit",
        "machine-1",
        null,
        null,
        null,
        `2026-05-12T12:0${String(i)}:00.000Z`,
      ],
    );
  }

  expect(getMemoryVerificationEvents(db, "memory-limit", -1)).toHaveLength(1);
  expect(getMemoryVerificationEvents(db, "memory-limit", 99999)).toHaveLength(3);
});
