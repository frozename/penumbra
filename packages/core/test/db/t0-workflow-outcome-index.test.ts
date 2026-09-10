import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";

import { applySchema, SCHEMA_VERSION } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // A sibling test may have already loaded SQLite.
  }
}

const NAME_EXPR =
  "CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.workflow_name') END";
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function freshDb(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

function plan(db: Database, sql: string, ...params: string[]): string {
  return db
    .query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join(" ");
}

test("workflow history seeks the workflow name and timestamp index", () => {
  expect(
    plan(
      freshDb(),
      `SELECT ts, event_type, payload_json FROM t0_events WHERE event_type = 'workflow.outcome' AND ${NAME_EXPR} = ? ORDER BY ts DESC LIMIT 20`,
      "adversarial-review",
    ),
  ).toContain("SEARCH t0_events USING INDEX t0_events_workflow_outcome_lookup (<expr>=?");
});

test("the poller session-handoff probe uses the workflow name index", () => {
  expect(
    plan(
      freshDb(),
      `SELECT ts FROM t0_events WHERE event_type = 'workflow.outcome' AND ${NAME_EXPR} = 'session-handoff' ORDER BY ts DESC LIMIT 1`,
    ),
  ).toContain("SEARCH t0_events USING INDEX t0_events_workflow_outcome_lookup (<expr>=?");
});

test("quality status uses the workflow name index with its time bound", () => {
  expect(
    plan(
      freshDb(),
      `SELECT payload_json FROM t0_events WHERE event_type = 'workflow.outcome' AND ts >= ? AND ${NAME_EXPR} = ? ORDER BY ts DESC`,
      "2026-09-01T00:00:00.000Z",
      "adversarial-review",
    ),
  ).toContain("SEARCH t0_events USING INDEX t0_events_workflow_outcome_lookup (<expr>=?");
});

test("bare json_extract cannot seek the guarded expression index", () => {
  expect(
    plan(
      freshDb(),
      "SELECT ts FROM t0_events WHERE event_type = 'workflow.outcome' AND json_extract(payload_json, '$.workflow_name') = ? ORDER BY ts DESC LIMIT 20",
      "adversarial-review",
    ),
  ).toContain("t0_by_type_ts");
});

test("the workflow report handoff lookup uses the run id index", () => {
  expect(
    plan(
      freshDb(),
      "SELECT handoff_id FROM handoffs WHERE workflow_run_id = ? AND dispatch_kind = 'workflow'",
      "run-1",
    ),
  ).toContain("SEARCH handoffs USING INDEX handoffs_workflow_run_id (workflow_run_id=?)");
});

test("existing stores gain both indexes after additive handoff columns", () => {
  const db = freshDb();
  db.run("DROP INDEX IF EXISTS t0_events_workflow_outcome_lookup");
  db.run("DROP INDEX IF EXISTS handoffs_workflow_run_id");
  db.run("ALTER TABLE handoffs DROP COLUMN workflow_run_id");
  applySchema(db, { embeddingDim: 384 });
  applySchema(db, { embeddingDim: 384 });
  expect(SCHEMA_VERSION).toBe(44);
  expect(plan(db, "SELECT handoff_id FROM handoffs WHERE workflow_run_id = ?", "run-1")).toContain(
    "handoffs_workflow_run_id",
  );
  expect(
    plan(
      db,
      `SELECT ts FROM t0_events WHERE event_type = 'workflow.outcome' AND ${NAME_EXPR} = ?`,
      "demo",
    ),
  ).toContain("SEARCH t0_events USING INDEX t0_events_workflow_outcome_lookup (<expr>=?");
});

test("building the workflow index tolerates existing malformed JSON", () => {
  const db = freshDb();
  db.run("DROP INDEX IF EXISTS t0_events_workflow_outcome_lookup");
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, payload_json) VALUES('malformed', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'test', 'u', 'm', 'workflow.outcome', 'unknown', '{')`,
  );
  applySchema(db, { embeddingDim: 384 });
  expect(
    db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE name = 't0_events_workflow_outcome_lookup'")
      .get()?.name,
  ).toBe("t0_events_workflow_outcome_lookup");
});

test("all three workflow name filters use the indexable expression", async () => {
  for (const file of [
    "packages/daemon/src/routes/workflows.ts",
    "packages/workflows/src/poller.ts",
    "packages/core/src/readers/quality-status.ts",
  ]) {
    const source = await Bun.file(resolve(import.meta.dir, "../../../..", file)).text();
    const bare = source.split("json_extract(payload_json, '$.workflow_name')").length - 1;
    const guarded = source.split(NAME_EXPR).length - 1;
    expect(guarded).toBeGreaterThan(0);
    expect(bare).toBe(guarded);
  }
});
