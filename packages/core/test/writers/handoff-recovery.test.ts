import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { HandoffWriter } from "@src/writers/handoff.js";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;
let writer: HandoffWriter;

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  writer = new HandoffWriter({ db });
});

test("requeueOrphanedDispatch happy path", () => {
  // Seed dispatched row with worker_id='dead-worker-1'
  db.run(`INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status, worker_id, root_handoff_id)
          VALUES ('h-1', '2026-05-20T10:00:00Z', 'p1', 'c1', 'f', 't', 'm', 'dispatched', 'dead-worker-1', 'h-1')`);

  const result = writer.requeueOrphanedDispatch("h-1", "dead-worker-1");
  expect(result).toBe(true);

  const row = db
    .query<
      { status: string; worker_id: string | null },
      [string]
    >("SELECT status, worker_id FROM handoffs WHERE handoff_id=?")
    .get("h-1");
  expect(row?.status).toBe("approved");
  expect(row?.worker_id).toBeNull();
});

test("requeueOrphanedDispatch race safety", () => {
  db.run(`INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status, worker_id, root_handoff_id)
          VALUES ('h-1', '2026-05-20T10:00:00Z', 'p1', 'c1', 'f', 't', 'm', 'dispatched', 'dead-worker-1', 'h-1')`);

  expect(writer.requeueOrphanedDispatch("h-1", "dead-worker-1")).toBe(true);
  expect(writer.requeueOrphanedDispatch("h-1", "dead-worker-1")).toBe(false);
});

test("requeueOrphanedDispatch wrong worker", () => {
  db.run(`INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status, worker_id, root_handoff_id)
          VALUES ('h-1', '2026-05-20T10:00:00Z', 'p1', 'c1', 'f', 't', 'm', 'dispatched', 'dead-worker-1', 'h-1')`);

  const result = writer.requeueOrphanedDispatch("h-1", "other-worker");
  expect(result).toBe(false);

  const row = db
    .query<
      { status: string; worker_id: string | null },
      [string]
    >("SELECT status, worker_id FROM handoffs WHERE handoff_id=?")
    .get("h-1");
  expect(row?.status).toBe("dispatched");
  expect(row?.worker_id).toBe("dead-worker-1");
});

test("failOrphanedDispatchExhausted happy path", () => {
  db.run(`INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status, worker_id, root_handoff_id)
          VALUES ('h-1', '2026-05-20T10:00:00Z', 'p1', 'c1', 'f', 't', 'm', 'dispatched', 'dead-worker-1', 'h-1')`);

  const result = writer.failOrphanedDispatchExhausted("h-1", "dead-worker-1");
  expect(result).toBe(true);

  const row = db
    .query<
      { status: string; resolution_reason: string | null; worker_id: string | null },
      [string]
    >("SELECT status, resolution_reason, worker_id FROM handoffs WHERE handoff_id=?")
    .get("h-1");
  expect(row?.status).toBe("failed");
  expect(row?.resolution_reason).toContain("failed_worker_restart");
  expect(row?.resolution_reason).toContain("attempts exhausted");
  expect(row?.worker_id).toBeNull();
});
