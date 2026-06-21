import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { migrate } from "../../src/db/migrations.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { recallStatus } from "../../src/readers/recall-status.js";
try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {
  // already loaded in this process
}

describe("recallStatus", () => {
  test("reports tier counts, t2 type/severity histograms, t1 promotion backlog, and corpus count", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    db.run(
      `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type, severity)
       VALUES ('m1', 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', 't', 'b', '{}', '2026-05-03', '2026-05-03', 'feature', 'info'),
              ('m2', 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', 't', 'b', '{}', '2026-05-03', '2026-05-03', 'bugfix', 'error')`,
    );
    db.run(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, ended_at, n_events, source_event_ids, t2_promoted_at, failed_promotion_attempts)
       VALUES ('r1', 'u', 's1', '2026-05-03', '2026-05-03', 1, '[]', NULL, 0),
              ('r2', 'u', 's2', '2026-05-03', '2026-05-03', 1, '[]', '2026-05-03', 0),
              ('r3', 'u', 's3', '2026-05-03', '2026-05-03', 1, '[]', NULL, 4)`,
    );

    const status = recallStatus(db);
    expect(status.tiers.t2).toBe(2);
    expect(status.tiers.t1).toBe(3);
    expect(status.t2_by_obs_type).toEqual({ feature: 1, bugfix: 1 });
    expect(status.t2_by_severity).toEqual({ info: 1, error: 1 });
    expect(status.t1_unpromoted).toBe(2);
    expect(status.t1_failed).toBe(1);
    expect(status.corpora).toBe(0);
  });
});
