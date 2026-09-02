import { loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runDispatchEventsSource } from "@src/recall-sources/dispatch.js";
import { runHandoffPendingSource } from "@src/recall-sources/handoff.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

test("dispatch_events filters by since", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES
      (1, 'h1', 'worker', 'dispatch.start', '2026-05-04T10:00:00Z', '{}'),
      (2, 'h1', 'worker', 'dispatch.end',   '2026-05-04T10:01:00Z', '{}'),
      (3, 'h2', 'worker', 'dispatch.start', '2026-05-04T11:00:00Z', '{}');
  `);

  const out = runDispatchEventsSource({ db, args: { since: "2026-05-04T10:30:00Z" } });
  expect(out.events.map((e) => e.id)).toEqual([3]);
  expect(out.summaries).toBeUndefined();
  expect(out.warnings).toEqual([]);
});

test("dispatch_events excludes heartbeat/watchdog ticks by default", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES
      (1, '',   'worker', 'heartbeat.received', '2026-05-07T10:00:00Z', '{}'),
      (2, '',   'worker', 'heartbeat.sent',     '2026-05-07T10:00:01Z', '{}'),
      (3, '',   'worker', 'watchdog.tick',      '2026-05-07T10:00:02Z', '{}'),
      (4, 'h1', 'worker', 'dispatch.start',     '2026-05-07T10:00:03Z', '{}'),
      (5, 'h1', 'worker', 'agent.tool_call.failed', '2026-05-07T10:00:04Z', '{}'),
      (6, 'h1', 'worker', 'dispatch.end',       '2026-05-07T10:00:05Z', '{}');
  `);

  const out = runDispatchEventsSource({ db, args: {} });
  expect(out.events.map((e) => e.id)).toEqual([4, 5, 6]);
  expect(out.summaries).toBeUndefined();
  expect(out.warnings).toEqual([]);
});

test("dispatch_events restores heartbeat/watchdog when include_heartbeats=true", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES
      (1, '',   'worker', 'heartbeat.received', '2026-05-07T10:00:00Z', '{}'),
      (2, 'h1', 'worker', 'dispatch.start',     '2026-05-07T10:00:03Z', '{}');
  `);

  const out = runDispatchEventsSource({ db, args: { include_heartbeats: true } });
  expect(out.events.map((e) => e.id)).toEqual([1, 2]);
  expect(out.summaries).toBeUndefined();
});

test("dispatch_events outcomes_only=true returns one summary per handoff with derived outcome/duration", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES
      ('h1', '2026-05-07T10:00:00Z', 'c1', 'maestro', 'codex', 'msg1', 'dispatched'),
      ('h2', '2026-05-07T11:00:00Z', 'c1', 'maestro', 'gemini', 'msg2', 'failed'),
      ('h3', '2026-05-07T12:00:00Z', 'c1', 'maestro', 'claude', 'msg3', 'dispatched');
  `);

  db.run(`
    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES
      (1, 'h1', 'worker', 'dispatch.start',         '2026-05-07T10:00:00Z', '{}'),
      (2, 'h1', 'worker', 'agent.tool_call.failed', '2026-05-07T10:00:20Z', '{}'),
      (3, 'h1', 'worker', 'dispatch.end',           '2026-05-07T10:01:00Z', '{}'),
      (4, 'h2', 'worker', 'dispatch.start',         '2026-05-07T11:00:00Z', '{}'),
      (5, 'h2', 'worker', 'dispatch.failed',        '2026-05-07T11:00:45Z', '{}'),
      (6, 'h3', 'worker', 'dispatch.start',         '2026-05-07T12:00:00Z', '{}');
  `);

  const out = runDispatchEventsSource({ db, args: { outcomes_only: true } });
  expect(out.events).toEqual([]);
  expect(out.warnings).toEqual([]);
  expect(out.summaries).toBeDefined();
  expect(out.summaries).toHaveLength(3);

  const byId = new Map((out.summaries ?? []).map((summary) => [summary.handoff_id, summary]));
  expect(byId.get("h1")).toEqual({
    handoff_id: "h1",
    agent: "codex",
    started_at: "2026-05-07T10:00:00Z",
    ended_at: "2026-05-07T10:01:00Z",
    duration_seconds: 60,
    outcome: "ok",
    failed_event_kinds: ["agent.tool_call.failed"],
  });
  expect(byId.get("h2")).toEqual({
    handoff_id: "h2",
    agent: "gemini",
    started_at: "2026-05-07T11:00:00Z",
    ended_at: "2026-05-07T11:00:45Z",
    duration_seconds: 45,
    outcome: "failed",
    failed_event_kinds: ["dispatch.failed"],
  });
  expect(byId.get("h3")).toEqual({
    handoff_id: "h3",
    agent: "claude",
    started_at: "2026-05-07T12:00:00Z",
    ended_at: null,
    duration_seconds: null,
    outcome: "in_progress",
    failed_event_kinds: [],
  });
});

test("dispatch_events outcomes_only=true keeps failed kinds for successful terminal dispatch", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES ('h1', '2026-05-07T10:00:00Z', 'c1', 'maestro', 'codex', 'msg1', 'dispatched');
  `);
  db.run(`
    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES
      (1, 'h1', 'worker', 'dispatch.start',         '2026-05-07T10:00:00Z', '{}'),
      (2, 'h1', 'worker', 'agent.tool_call.failed', '2026-05-07T10:00:02Z', '{}'),
      (3, 'h1', 'worker', 'dispatch.end',           '2026-05-07T10:00:10Z', '{}');
  `);
  const out = runDispatchEventsSource({ db, args: { outcomes_only: true } });
  expect(out.summaries?.[0]?.outcome).toBe("ok");
  expect(out.summaries?.[0]?.failed_event_kinds).toEqual(["agent.tool_call.failed"]);
});

test("dispatch_events outcomes_only=true omits dream events without a matching handoff", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES (1, 'dream-cycle-1', 'daemon', 'dream_p4_query_rewrite_failed', '2026-05-07T10:00:00Z', '{}');
  `);

  const out = runDispatchEventsSource({ db, args: { outcomes_only: true } });
  expect(out.summaries).toEqual([]);
});

test("dispatch_events outcomes_only=true marks cancel kinds as failed", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES ('h1', '2026-05-07T10:00:00Z', 'c1', 'maestro', 'codex', 'msg1', 'failed');
  `);
  db.run(`
    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES
      (1, 'h1', 'worker', 'dispatch.start',  '2026-05-07T10:00:00Z', '{}'),
      (2, 'h1', 'worker', 'dispatch.cancel', '2026-05-07T10:00:05Z', '{}');
  `);
  const out = runDispatchEventsSource({ db, args: { outcomes_only: true } });
  expect(out.summaries?.[0]?.outcome).toBe("failed");
});

test("dispatch_events outcomes_only=true applies limit to most-recently created handoffs", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  let eventId = 1;
  const insertHandoff = db.query(
    `INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
     VALUES (?, ?, 'c1', 'maestro', 'codex', 'msg', 'dispatched')`,
  );
  const insertEvent = db.query(
    `INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
     VALUES (?, ?, 'worker', ?, ?, '{}')`,
  );
  const baseMs = Date.parse("2026-05-06T00:00:00Z");

  for (let i = 0; i < 120; i += 1) {
    const handoffId = `h${String(i).padStart(3, "0")}`;
    const startMs = baseMs + i * 12 * 60 * 1000;
    insertHandoff.run(handoffId, new Date(startMs).toISOString());
    insertEvent.run(eventId++, handoffId, "dispatch.start", new Date(startMs).toISOString());
    insertEvent.run(
      eventId++,
      handoffId,
      "agent.tool_call.failed",
      new Date(startMs + 20_000).toISOString(),
    );
    insertEvent.run(eventId++, handoffId, "dispatch.end", new Date(startMs + 40_000).toISOString());
    insertEvent.run(eventId++, "", "heartbeat.sent", new Date(startMs + 50_000).toISOString());
  }

  const out = runDispatchEventsSource({ db, args: { outcomes_only: true, limit: 50 } });
  const summaryIndexes = (out.summaries ?? []).map((summary) =>
    Number(summary.handoff_id.slice(1)),
  );
  expect(summaryIndexes).toHaveLength(50);
  expect(summaryIndexes).toContain(119);
  expect(summaryIndexes).toContain(70);
  expect(summaryIndexes).not.toContain(69);
});

test("dispatch_events outcomes_only attributes by handoff creation, not event ts", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, cancel_requested_at)
    VALUES
      ('h_stale', '2026-05-11T10:12:48Z', 'c1', 'maestro', 'codex', 'stale msg', 'expired', '2026-05-11T10:12:48Z'),
      ('h_new',   '2026-09-01T21:55:43Z', 'c1', 'maestro', 'gemini', 'new msg', 'completed', NULL);
  `);

  db.run(`
    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES
      (1, 'h_stale', 'worker', 'cancel.received',   '2026-09-01T21:55:01Z', '{"matched":false}'),
      (2, 'h_stale', 'worker', 'cancel.dispatched', '2026-09-01T21:55:02Z', '{"matched":false}'),
      (3, 'h_new',   'worker', 'dispatch.start',    '2026-09-01T21:55:43Z', '{}'),
      (4, 'h_new',   'worker', 'dispatch.end',      '2026-09-01T21:56:48Z', '{}');
  `);

  const out = runDispatchEventsSource({
    db,
    args: { since: "2026-09-01T20:38:37Z", outcomes_only: true, limit: 100 },
  });
  expect(out.summaries?.map((s) => s.handoff_id)).toEqual(["h_new"]);
});

test("dispatch_events replay burst does not crowd out session dispatches under limit", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  let eventId = 1;
  const insertHandoff = db.query(
    `INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
     VALUES (?, ?, 'c1', 'maestro', 'codex', 'msg', 'dispatched')`,
  );
  const insertEvent = db.query(
    `INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
     VALUES (?, ?, 'worker', ?, ?, '{}')`,
  );

  const windowStart = "2026-09-01T20:38:37Z";
  const baseMs = Date.parse(windowStart);

  for (let i = 0; i < 30; i += 1) {
    const handoffId = `h_real_${String(i).padStart(2, "0")}`;
    const startMs = baseMs + 1000 + i * 60_000;
    insertHandoff.run(handoffId, new Date(startMs).toISOString());
    insertEvent.run(eventId++, handoffId, "dispatch.start", new Date(startMs).toISOString());
    insertEvent.run(eventId++, handoffId, "dispatch.end", new Date(startMs + 30_000).toISOString());
  }

  const staleId = "h_stale";
  const insertStaleHandoff = db.query(
    `INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, cancel_requested_at)
     VALUES (?, '2026-05-11T10:12:48Z', 'c1', 'maestro', 'codex', 'stale', 'expired', '2026-05-11T10:12:48Z')`,
  );
  insertStaleHandoff.run(staleId);

  const replayBaseMs = baseMs + 30 * 60_000 + 10_000;
  for (let i = 0; i < 96; i += 1) {
    const kind = i % 2 === 0 ? "cancel.received" : "cancel.dispatched";
    insertEvent.run(eventId++, staleId, kind, new Date(replayBaseMs + i * 1000).toISOString());
  }

  const out = runDispatchEventsSource({
    db,
    args: { since: windowStart, outcomes_only: true, limit: 100 },
  });
  expect(out.summaries).toHaveLength(30);
  expect(out.summaries?.every((s) => s.handoff_id !== staleId)).toBe(true);
});

test("dispatch_events outcomes_only caps events per handoff, not globally", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  let eventId = 1;
  const insertHandoff = db.query(
    `INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
     VALUES (?, ?, 'c1', 'maestro', 'codex', 'msg', 'dispatched')`,
  );
  const insertEvent = db.query(
    `INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
     VALUES (?, ?, 'worker', ?, ?, '{}')`,
  );
  const baseMs = Date.parse("2026-05-08T00:00:00Z");

  insertHandoff.run("h_chatty", new Date(baseMs + 1_000).toISOString());
  insertHandoff.run("h_late", new Date(baseMs + 2_000).toISOString());

  insertEvent.run(eventId++, "h_chatty", "dispatch.start", new Date(baseMs + 10_000).toISOString());
  for (let i = 0; i < 450; i += 1) {
    insertEvent.run(
      eventId++,
      "h_chatty",
      "agent.thought",
      new Date(baseMs + 11_000 + i * 1000).toISOString(),
    );
  }
  insertEvent.run(eventId++, "h_chatty", "dispatch.end", new Date(baseMs + 462_000).toISOString());
  insertEvent.run(eventId++, "h_late", "dispatch.start", new Date(baseMs + 500_000).toISOString());
  insertEvent.run(eventId++, "h_late", "dispatch.end", new Date(baseMs + 560_000).toISOString());

  const out = runDispatchEventsSource({
    db,
    args: { since: new Date(baseMs).toISOString(), outcomes_only: true, limit: 100 },
  });
  const byId = new Map((out.summaries ?? []).map((summary) => [summary.handoff_id, summary]));

  expect(Array.from(byId.keys()).sort()).toEqual(["h_chatty", "h_late"]);
  expect(byId.get("h_chatty")?.outcome).toBe("ok");
  expect(byId.get("h_late")?.outcome).toBe("ok");
});

test("dispatch_events outcomes_only keeps the terminal event when post-terminal rows exceed the per-handoff cap", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  let eventId = 1;
  const insertEvent = db.query(
    `INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
     VALUES (?, 'h1', 'worker', ?, ?, '{}')`,
  );
  const baseMs = Date.parse("2026-05-09T00:00:00Z");

  db.run(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES ('h1', '2026-05-09T00:00:00.000Z', 'c1', 'maestro', 'codex', 'msg', 'completed');
  `);
  insertEvent.run(eventId++, "dispatch.start", new Date(baseMs).toISOString());
  insertEvent.run(eventId++, "dispatch.end", new Date(baseMs + 1_000).toISOString());
  for (let i = 0; i < 250; i += 1) {
    insertEvent.run(
      eventId++,
      "agent.thought.signal",
      new Date(baseMs + 2_000 + i * 1000).toISOString(),
    );
  }

  const out = runDispatchEventsSource({
    db,
    args: { outcomes_only: true, limit: 100 },
  });

  expect(out.summaries).toHaveLength(1);
  expect(out.summaries?.[0]?.handoff_id).toBe("h1");
  expect(out.summaries?.[0]?.outcome).toBe("ok");
});

test("handoff.list_pending returns pending only", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES
      ('h1', '2026-05-04T10:00:00Z', 'c1', 'a', 'b', 'msg1', 'pending'),
      ('h2', '2026-05-04T10:05:00Z', 'c1', 'a', 'b', 'msg2', 'completed');
  `);

  const out = runHandoffPendingSource({ db });
  expect(out.handoffs.map((h) => h.handoff_id)).toEqual(["h1"]);
  expect(out.warnings).toEqual([]);
});
