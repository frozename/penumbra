import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { HandoffReader } from "@src/readers/handoff.js";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;
let reader: HandoffReader;

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  reader = new HandoffReader({ db });
});

test("listOrphanedDispatches with empty array returns []", () => {
  const result = reader.listOrphanedDispatches([]);
  expect(result).toEqual([]);
});

test("listOrphanedDispatches happy path", () => {
  db.run(`INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status, worker_id, root_handoff_id)
          VALUES ('h-1', 't', 'p', 'c', 'f', 't', 'm', 'dispatched', 'dead-1', 'h-1')`);
  db.run(`INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status, worker_id, root_handoff_id)
          VALUES ('h-2', 't', 'p', 'c', 'f', 't', 'm', 'dispatched', 'dead-2', 'h-1')`);
  db.run(`INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status, worker_id, root_handoff_id)
          VALUES ('h-3', 't', 'p', 'c', 'f', 't', 'm', 'dispatched', 'active-1', 'h-1')`);
  db.run(`INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status, worker_id, root_handoff_id)
          VALUES ('h-4', 't', 'p', 'c', 'f', 't', 'm', 'approved', NULL, 'h-1')`);

  const results = reader.listOrphanedDispatches(["dead-1", "dead-2"]);
  expect(results).toHaveLength(2);
  const ids = results.map((r) => r.handoff_id).sort();
  expect(ids).toEqual(["h-1", "h-2"]);
});
