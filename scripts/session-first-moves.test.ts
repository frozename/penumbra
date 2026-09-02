import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "session-first-moves.ts");

test("reads near-duplicate promotion gate counts from dream_actions payload source", () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "session-first-moves-"));
  try {
    writeFileSync(join(storageRoot, "port"), "9");
    writeFileSync(join(storageRoot, "token"), "test-token");
    mkdirSync(storageRoot, { recursive: true });

    const db = new Database(join(storageRoot, "db.sqlite"));
    try {
      db.run("CREATE TABLE t1_rollups (promotion_filtered_at INTEGER)");
      db.run(
        `CREATE TABLE dream_actions (
          action_id TEXT PRIMARY KEY,
          cycle_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          action_type TEXT NOT NULL,
          confidence REAL NOT NULL,
          status TEXT NOT NULL,
          target_ids TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )`,
      );
      db.run("INSERT INTO t1_rollups(promotion_filtered_at) VALUES (1), (NULL)");
      db.run(
        `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
         VALUES
          ('a-queued', 'c1', 'P3', 'retire', 0.9, 'queued', '["t1","t2"]', '{"source":"t2_promotion_near_dup_gate"}'),
          ('a-approved', 'c1', 'P3', 'retire', 0.9, 'approved', '["t3","t4"]', '{"source":"t2_promotion_near_dup_gate"}'),
          ('a-auto', 'c1', 'P3', 'retire', 0.9, 'auto_applied', '["t5","t6"]', '{"source":"t2_promotion_near_dup_gate"}'),
          ('a-completed', 'c1', 'P3', 'retire', 0.9, 'completed', '["t7","t8"]', '{"source":"t2_promotion_near_dup_gate"}'),
          ('a-other', 'c1', 'P3', 'retire', 0.9, 'queued', '["t9","t10"]', '{"source":"other"}')`,
      );
    } finally {
      db.close();
    }

    const result = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT],
      env: { ...process.env, PENUMBRA_STORAGE_ROOT: storageRoot },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    const output: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
    if (typeof output !== "object" || output === null) throw new Error("invalid script output");
    expect((output as { gate_deltas?: unknown }).gate_deltas).toEqual({
      filtered: 1,
      neardup: 3,
    });
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});
