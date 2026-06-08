/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures and sqlite row mocks intentionally use loose shapes */
import { expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { migrate } from "../../src/db/migrations.js";
import { T0Writer } from "../../src/writers/t0.js";
import { T0EventSchema } from "../../src/schemas/event.js";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

const sample = T0EventSchema.parse({
  event_id: "e1",
  ts: "2026-04-23T11:59:59.000Z",
  ingest_ts: "2026-04-23T12:00:00.000Z",
  source: "mcp",
  source_detail: "claude-code",
  project_id: null,
  user_id: "u",
  machine_id: "m",
  session_id: "s",
  event_type: "agent-tool-use",
  lane: "local",
  provider: null,
  model: null,
  tokens_in: null,
  tokens_out: null,
  cost_usd: null,
  latency_ms: null,
  request_id: null,
  payload_json: { tool: "Read" },
  payload_summary: "Read src/x.ts",
  origin: "maestro",
});

test("writes a row and is retrievable", () => {
  const w = new T0Writer(db);
  w.write(sample);
  const row = db
    .query<
      { event_id: string; payload_json: string; origin: string | null },
      [string]
    >("SELECT event_id, payload_json, origin FROM t0_events WHERE event_id=?")
    .get("e1");
  expect(row?.event_id).toBe("e1");
  expect(JSON.parse(row!.payload_json)).toEqual({ tool: "Read" });
  expect(row!.origin).toBe("maestro");
});

test("writes origin=dispatch round-trips", () => {
  const w = new T0Writer(db);
  const dispatchEvent = T0EventSchema.parse({ ...sample, event_id: "e2", origin: "dispatch" });
  w.write(dispatchEvent);
  const row = db
    .query<{ origin: string | null }, [string]>("SELECT origin FROM t0_events WHERE event_id=?")
    .get("e2");
  expect(row!.origin).toBe("dispatch");
});

test("writes origin=null when not set (legacy compat)", () => {
  const w = new T0Writer(db);
  // Bypass schema to simulate a legacy-shaped row (origin omitted)
  const e = { ...sample, event_id: "e3", origin: null } as any;
  w.write(e);
  const row = db
    .query<{ origin: string | null }, [string]>("SELECT origin FROM t0_events WHERE event_id=?")
    .get("e3");
  expect(row!.origin).toBeNull();
});

test("duplicate event_id returns existing id without throwing, row count stays 1", () => {
  const w = new T0Writer(db);
  const firstId = w.write(sample);

  const secondId = w.write(sample);
  const rowCount = db
    .query<{ count: number }, [string]>("SELECT count(*) AS count FROM t0_events WHERE event_id=?")
    .get("e1")!.count;

  const distinctCount = db
    .query<{ count: number }, []>("SELECT count(*) AS count FROM t0_events")
    .get()!.count;

  expect(secondId).toBe(firstId);
  expect(rowCount).toBe(1);
  expect(distinctCount).toBe(1);

  const e2 = { ...sample, event_id: "e2" };
  const thirdId = w.write(e2);
  const totalCount = db
    .query<{ count: number }, []>("SELECT count(*) AS count FROM t0_events")
    .get()!.count;
  expect(totalCount).toBe(2);
  expect(thirdId).toBe("e2");
});
