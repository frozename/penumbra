import { loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runHandoffPendingSource } from "@src/recall-sources/handoff.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

test("conversation_id filter: returns only pending rows from the specified conversation", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES
      ('h1', '2026-05-04T10:00:00Z', 'c1', 'a', 'b', 'msg1', 'pending'),
      ('h2', '2026-05-04T10:05:00Z', 'c2', 'a', 'b', 'msg2', 'pending');
  `);

  const out = runHandoffPendingSource({ db, args: { conversation_id: "c1" } });
  expect(out.handoffs.map((h) => h.handoff_id)).toEqual(["h1"]);
  expect(out.warnings).toEqual([]);
});

test("conversation_id filter excludes non-pending rows in the same conversation", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES
      ('h1', '2026-05-04T10:00:00Z', 'c1', 'a', 'b', 'msg1', 'pending'),
      ('h2', '2026-05-04T10:05:00Z', 'c1', 'a', 'b', 'msg2', 'completed');
  `);

  const out = runHandoffPendingSource({ db, args: { conversation_id: "c1" } });
  expect(out.handoffs.map((h) => h.handoff_id)).toEqual(["h1"]);
  expect(out.warnings).toEqual([]);
});

test("no args returns pending rows from every conversation", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES
      ('h1', '2026-05-04T10:00:00Z', 'c1', 'a', 'b', 'msg1', 'pending'),
      ('h2', '2026-05-04T10:05:00Z', 'c2', 'a', 'b', 'msg2', 'pending'),
      ('h3', '2026-05-04T10:10:00Z', 'c1', 'a', 'b', 'msg3', 'completed');
  `);

  const out = runHandoffPendingSource({ db });
  expect(out.handoffs.map((h) => h.handoff_id)).toEqual(["h1", "h2"]);
  expect(out.warnings).toEqual([]);
});

test("ordering is ts ASC regardless of insert order", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES
      ('h-later', '2026-05-04T12:00:00Z', 'c1', 'a', 'b', 'msg-later', 'pending'),
      ('h-earlier', '2026-05-04T10:00:00Z', 'c1', 'a', 'b', 'msg-earlier', 'pending');
  `);

  const out = runHandoffPendingSource({ db });
  expect(out.handoffs.map((h) => h.handoff_id)).toEqual(["h-earlier", "h-later"]);
  expect(out.warnings).toEqual([]);
});

test("projected row shape includes project_id and to_role (null or set)", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status)
    VALUES
      ('h1', '2026-05-04T10:00:00Z', 'p1', 'c1', 'a', 'b', 'reviewer', 'msg1', 'pending'),
      ('h2', '2026-05-04T10:05:00Z', NULL, 'c2', 'a', 'b', NULL, 'msg2', 'pending');
  `);

  const out = runHandoffPendingSource({ db });
  expect(out.handoffs).toHaveLength(2);
  expect(out.handoffs[0]).toEqual({
    handoff_id: "h1",
    ts: "2026-05-04T10:00:00Z",
    project_id: "p1",
    conversation_id: "c1",
    from_agent: "a",
    to_agent: "b",
    to_role: "reviewer",
    message: "msg1",
    status: "pending",
  });
  expect(out.handoffs[1]).toEqual({
    handoff_id: "h2",
    ts: "2026-05-04T10:05:00Z",
    project_id: null,
    conversation_id: "c2",
    from_agent: "a",
    to_agent: "b",
    to_role: null,
    message: "msg2",
    status: "pending",
  });
  expect(out.warnings).toEqual([]);
});

test("error path: no migrate returns empty handoffs with warning starting with 'handoff.list_pending: '", () => {
  const db = new Database(":memory:");
  // intentionally skip loadSqliteVec and migrate

  const out = runHandoffPendingSource({ db });
  expect(out.handoffs).toEqual([]);
  expect(out.warnings).toHaveLength(1);
  expect(out.warnings[0]).toMatch(/^handoff\.list_pending: /);
});
