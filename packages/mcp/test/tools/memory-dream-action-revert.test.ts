import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { revertDreamAction } from "../../../daemon/src/dreaming/reembed.js";

describe("memory-dream-action-revert", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
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
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("cascade=none refuses with /has_dependents/i when dependents exist", () => {
    db.exec(`
      INSERT INTO t2_memories(rowid, memory_id, embedding_model_version) VALUES(1, 'm1', 'v2');
      INSERT INTO t2_vec(rowid, embedding) VALUES(1, X'00');
      INSERT INTO t2_vec_history(history_id, memory_id, embedding, embedding_model_version, snapshotted_at) 
      VALUES('h1', 'm1', X'01', 'v1', 100);

      INSERT INTO dream_actions(action_id, phase, status, target_ids, payload_json, decided_at)
      VALUES('a1', 'P7', 'auto_applied', '["m1"]', '{}', 200);

      INSERT INTO dream_actions(action_id, phase, status, target_ids, payload_json, decided_at)
      VALUES('a2', 'P7', 'auto_applied', '["m1"]', '{"source_action_id":"a1"}', 300);
    `);

    expect(() => revertDreamAction(db, "a1", "none")).toThrow(/has_dependents/i);
  });

  it("cascade=force reverts topologically, sets reverted_by on parent + child", () => {
    db.exec(`
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
    `);

    revertDreamAction(db, "a1", "force");

    const a1 = db
      .prepare('SELECT reverted_by FROM dream_actions WHERE action_id = "a1"')
      .get() as any;
    const a2 = db
      .prepare('SELECT reverted_by FROM dream_actions WHERE action_id = "a2"')
      .get() as any;

    expect(a1.reverted_by).toBe("user");
    expect(a2.reverted_by).toBe("user");
  });

  it("P3 soft revert with no dependents works", () => {
    db.exec(`
      INSERT INTO dream_actions(action_id, phase, status, target_ids, payload_json, decided_at)
      VALUES('a3', 'P3', 'auto_applied', '[]', '{}', 100);
    `);

    expect(() => revertDreamAction(db, "a3", "none")).not.toThrow();

    const a3 = db
      .prepare('SELECT reverted_by FROM dream_actions WHERE action_id = "a3"')
      .get() as any;
    expect(a3.reverted_by).toBe("user");
  });

  it("P3 has_dependents check works cross-phase", () => {
    db.exec(`
      INSERT INTO dream_actions(action_id, phase, status, target_ids, payload_json, decided_at)
      VALUES('a4', 'P3', 'auto_applied', '[]', '{}', 100);

      INSERT INTO dream_actions(action_id, phase, status, target_ids, payload_json, decided_at)
      VALUES('a5', 'P5', 'auto_applied', '[]', '{"source_action_id":"a4"}', 200);
    `);

    expect(() => revertDreamAction(db, "a4", "none")).toThrow(/has_dependents/i);

    revertDreamAction(db, "a4", "force");

    const a4 = db
      .prepare('SELECT reverted_by FROM dream_actions WHERE action_id = "a4"')
      .get() as any;
    const a5 = db
      .prepare('SELECT reverted_by FROM dream_actions WHERE action_id = "a5"')
      .get() as any;

    expect(a4.reverted_by).toBe("user");
    expect(a5.reverted_by).toBe("user");
  });
});
