import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";

import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import {
  AGGREGATE_HANDOFF_USAGE_SQL,
  aggregateHandoffUsage,
} from "@src/services/agent-performance-capture.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // A sibling test may have already loaded SQLite.
  }
}

const HANDOFF_EXPR =
  "CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.handoff_id') END";
const POLLER_DISPATCH_END_SQL =
  "SELECT ts FROM dispatch_events WHERE kind = 'dispatch.end' ORDER BY ts DESC LIMIT 1";

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

function insertUsageUpdate(
  db: Database,
  eventId: string,
  payloadJson: string,
  costUsd: number | null = null,
): void {
  db.prepare(
    `INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, cost_usd, payload_json)
     VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'usage-update', 'cli-subscription', 'anthropic', 'claude', ?, ?)`,
  ).run(eventId, "2026-10-06T14:00:00.000Z", "2026-10-06T14:00:00.000Z", costUsd, payloadJson);
}

test("aggregateHandoffUsage seeks the usage-update handoff expression index", () => {
  expect(plan(freshDb(), AGGREGATE_HANDOFF_USAGE_SQL, "h-a")).toContain(
    "USING INDEX t0_events_usage_update_handoff",
  );
});

test("bare json_extract cannot seek the usage-update handoff index", () => {
  const drifted = AGGREGATE_HANDOFF_USAGE_SQL.replace(
    HANDOFF_EXPR,
    "json_extract(payload_json, '$.handoff_id')",
  );
  expect(drifted).not.toBe(AGGREGATE_HANDOFF_USAGE_SQL);
  expect(plan(freshDb(), drifted, "h-a")).not.toContain("t0_events_usage_update_handoff");
});

test("the poller dispatch.end probe reverse-scans the partial ts index", () => {
  const detail = plan(freshDb(), POLLER_DISPATCH_END_SQL);
  expect(detail).toContain("idx_dispatch_events_end_ts");
  expect(detail).not.toContain("TEMP B-TREE");
});

test("aggregateHandoffUsage sums only the target handoff and survives malformed payloads", () => {
  const db = freshDb();
  insertUsageUpdate(db, "u-a1", JSON.stringify({ handoff_id: "h-a", used: 100 }), 0.5);
  insertUsageUpdate(db, "u-a2", JSON.stringify({ handoff_id: "h-a", used: 250 }), 0.25);
  insertUsageUpdate(db, "u-b1", JSON.stringify({ handoff_id: "h-b", used: 999 }), 9.75);
  insertUsageUpdate(db, "u-c1", JSON.stringify({ handoff_id: "h-c", used: 7 }), null);
  insertUsageUpdate(db, "u-mal", "{");

  const a = aggregateHandoffUsage(db, "h-a");
  expect(a.cost_usd).toBe(0.75);
  expect(a.tokens_used).toBe(350);

  const c = aggregateHandoffUsage(db, "h-c");
  expect(c.cost_usd).toBeNull();
  expect(c.tokens_used).toBe(7);

  expect(aggregateHandoffUsage(db, "h-missing")).toEqual({
    cost_usd: null,
    tokens_used: null,
  });
});

test("applySchema builds the usage-update index over malformed payloads", () => {
  const db = freshDb();
  db.run("DROP INDEX IF EXISTS t0_events_usage_update_handoff");
  insertUsageUpdate(db, "u-mal", "{");
  applySchema(db, { embeddingDim: 384 });
  expect(
    db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE name = 't0_events_usage_update_handoff'")
      .get()?.name,
  ).toBe("t0_events_usage_update_handoff");
});

test("existing stores gain both indexes on re-apply", () => {
  const db = freshDb();
  db.run("DROP INDEX IF EXISTS t0_events_usage_update_handoff");
  db.run("DROP INDEX IF EXISTS idx_dispatch_events_end_ts");
  applySchema(db, { embeddingDim: 384 });
  const names = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name);
  expect(names).toContain("t0_events_usage_update_handoff");
  expect(names).toContain("idx_dispatch_events_end_ts");
});

test("the shipped statements keep the forms the indexes cover", async () => {
  const captureSource = await Bun.file(
    resolve(import.meta.dir, "../../src/services/agent-performance-capture.ts"),
  ).text();
  // The plan pin is only meaningful while the function prepares the pinned SQL.
  expect(captureSource).toMatch(/\.prepare<Row, \[string\]>\(\s*AGGREGATE_HANDOFF_USAGE_SQL\s*\)/);
  // Every payload handoff_id read must carry the json_valid guard — the
  // expression index only seeks when the query text matches verbatim.
  const bare = captureSource.split("json_extract(payload_json, '$.handoff_id')").length - 1;
  const guarded = captureSource.split(HANDOFF_EXPR).length - 1;
  expect(guarded).toBeGreaterThan(0);
  expect(bare).toBe(guarded);

  const pollerSource = await Bun.file(
    resolve(import.meta.dir, "../../../..", "packages/workflows/src/poller.ts"),
  ).text();
  expect(pollerSource).toContain(POLLER_DISPATCH_END_SQL);
});
