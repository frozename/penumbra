import { migrate } from "@src/db/migrations.js";
import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("applySchema adds agent_kind to agent_performance and leaves existing rows null", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  db.query(
    `INSERT INTO agent_performance (
      performance_id, ts, handoff_id, agent_name, task_type, outcome, source, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("p1", "2026-05-01T00:00:00Z", "h1", "claude", "health_check", "failed", "reconciler", "{}");

  migrate(db, { embeddingDim: 384 });

  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info('agent_performance')`)
    .all()
    .map((r) => r.name);
  expect(cols).toContain("agent_kind");

  const row = db
    .query<
      { agent_kind: string | null },
      []
    >(`SELECT agent_kind FROM agent_performance WHERE handoff_id='h1'`)
    .get();
  expect(row?.agent_kind).toBeNull();
});
