import { applySchema, loadSqliteVec } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { TICK_CHAIN_COST_SQL } from "@src/long-lived/teardown.js";

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

test("tick teardown's chain-cost lookup seeks the agent_performance conversation index", () => {
  expect(plan(freshDb(), TICK_CHAIN_COST_SQL, "chain-1")).toContain(
    "SEARCH agent_performance USING INDEX agent_perf_by_conversation (conversation_id=?)",
  );
});
