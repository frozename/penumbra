import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { revertDreamAction } from "../../../daemon/src/dreaming/reembed.js";

interface RevertedByRow {
  reverted_by: string | null;
}

function runSqlStatements(db: Database, sql: string): void {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    db.run(statement);
  }
}

function readRevertedBy(db: Database, actionId: string): RevertedByRow {
  const row = db
    .prepare("SELECT reverted_by FROM dream_actions WHERE action_id = ?")
    .get(actionId) as RevertedByRow | null;
  if (row === null) throw new Error(`expected dream_actions row for ${actionId}`);
  return row;
}

describe("memory-dream-action-revert", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runSqlStatements(
      db,
      `
      CREATE TABLE dream_actions(
        action_id TEXT PRIMARY KEY,
        phase TEXT,
        action_type TEXT,
        status TEXT,
        target_ids TEXT,
        payload_json TEXT,
        decided_at INTEGER,
        reverted_by TEXT
      );
      CREATE TABLE t2_memories(
        rowid INTEGER PRIMARY KEY,
        memory_id TEXT,
        embedding_model_version TEXT
      );
      CREATE TABLE t2_vec(
        rowid INTEGER PRIMARY KEY,
        embedding BLOB
      );
      CREATE TABLE t2_vec_history(
        history_id TEXT PRIMARY KEY,
        memory_id TEXT,
        embedding BLOB,
        embedding_model_version TEXT,
        snapshotted_at INTEGER,
        snapshotted_by_cycle TEXT
      );
    `,
    );
  });

  afterEach(() => {
    db.close();
  });

  it("cascade=none refuses with /has_dependents/i when dependents exist", () => {
    runSqlStatements(
      db,
      `
      INSERT INTO t2_memories(rowid, memory_id, embedding_model_version) VALUES(1, 'm1', 'v2');
      INSERT INTO t2_vec(rowid, embedding) VALUES(1, X'00');
      INSERT INTO t2_vec_history(history_id, memory_id, embedding, embedding_model_version, snapshotted_at)
      VALUES('h1', 'm1', X'01', 'v1', 100);

      INSERT INTO dream_actions(action_id, phase, status, target_ids, payload_json, decided_at)
      VALUES('a1', 'P7', 'auto_applied', '["m1"]', '{}', 200);

      INSERT INTO dream_actions(action_id, phase, status, target_ids, payload_json, decided_at)
      VALUES('a2', 'P7', 'auto_applied', '["m1"]', '{"source_action_id":"a1"}', 300);
    `,
    );

    expect(() => {
      revertDreamAction(db, "a1", "none");
    }).toThrow(/has_dependents/i);
  });

  it("cascade=force reverts topologically, sets reverted_by on parent + child", () => {
    runSqlStatements(
      db,
      `
      INSERT INTO t2_memories(rowid, memory_id, embedding_model_version) VALUES(1, 'm1', 'v3');
      INSERT INTO t2_vec(rowid, embedding) VALUES(1, X'00');

      INSERT INTO t2_vec_history(history_id, memory_id, embedding, embedding_model_version, snapshotted_at)
      VALUES('h1', 'm1', X'01', 'v1', 100);

      INSERT INTO t2_vec_history(history_id, memory_id, embedding, embedding_model_version, snapshotted_at)
      VALUES('h2', 'm1', X'02', 'v2', 250);

      INSERT INTO dream_actions(action_id, phase, status, target_ids, payload_json, decided_at)
      VALUES('a1', 'P7', 'auto_applied', '["m1"]', '{}', 200);

      INSERT INTO dream_actions(action_id, phase, status, target_ids, payload_json, decided_at)
      VALUES('a2', 'P7', 'auto_applied', '["m1"]', '{"source_action_id":"a1"}', 300);
    `,
    );

    revertDreamAction(db, "a1", "force");

    expect(readRevertedBy(db, "a1").reverted_by).toBe("user");
    expect(readRevertedBy(db, "a2").reverted_by).toBe("user");
  });

  it("P3 soft revert with no dependents works", () => {
    runSqlStatements(
      db,
      `
      INSERT INTO dream_actions(action_id, phase, status, target_ids, payload_json, decided_at)
      VALUES('a3', 'P3', 'auto_applied', '[]', '{}', 100);
    `,
    );

    expect(() => {
      revertDreamAction(db, "a3", "none");
    }).not.toThrow();

    expect(readRevertedBy(db, "a3").reverted_by).toBe("user");
  });

  it("P3 has_dependents check works cross-phase", () => {
    runSqlStatements(
      db,
      `
      INSERT INTO dream_actions(action_id, phase, status, target_ids, payload_json, decided_at)
      VALUES('a4', 'P3', 'auto_applied', '[]', '{}', 100);

      INSERT INTO dream_actions(action_id, phase, status, target_ids, payload_json, decided_at)
      VALUES('a5', 'P5', 'auto_applied', '[]', '{"source_action_id":"a4"}', 200);
    `,
    );

    expect(() => {
      revertDreamAction(db, "a4", "none");
    }).toThrow(/has_dependents/i);

    revertDreamAction(db, "a4", "force");

    expect(readRevertedBy(db, "a4").reverted_by).toBe("user");
    expect(readRevertedBy(db, "a5").reverted_by).toBe("user");
  });
});
