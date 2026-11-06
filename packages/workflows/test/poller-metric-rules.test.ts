import { loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { computeStateMetrics, type GitLogSinceCounter } from "../src/poller.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function insertHandoff(db: Database, id: string, ts: string, status: string): void {
  db.prepare(
    `INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
     VALUES (?, ?, 'conv', 'agent-a', 'agent-b', 'msg', ?)`,
  ).run(id, ts, status);
}

function insertDispatchEvent(db: Database, handoffId: string, kind: string, ts: string): void {
  db.prepare(
    `INSERT INTO dispatch_events (handoff_id, source, kind, ts, meta_json)
     VALUES (?, 'worker', ?, ?, '{}')`,
  ).run(handoffId, kind, ts);
}

function insertT0(
  db: Database,
  eventId: string,
  ts: string,
  eventType: string,
  payloadJson: string,
): void {
  db.prepare(
    `INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id,
      user_id, machine_id, session_id, event_type, lane,
      provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
      request_id, payload_json, payload_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
  ).run(
    eventId,
    ts,
    ts,
    "agentchat",
    "workflows",
    "p",
    "u",
    "m",
    "s",
    eventType,
    "local",
    payloadJson,
  );
}

const now = (): Date => new Date("2026-05-04T12:00:00Z");
const nullTranscript = (): null => null;

test("empty db reports queue-idle-min and time-since-last-handoff-min as 0", () => {
  const db = freshDb();
  const m = computeStateMetrics({ db, now, transcriptReader: nullTranscript });
  expect(m["queue-idle-min"]).toBe(0);
  expect(m["time-since-last-handoff-min"]).toBe(0);
});

test("time-since-last-handoff-min uses latest handoff ts regardless of status", () => {
  const db = freshDb();
  insertHandoff(db, "h1", "2026-05-04T11:50:00Z", "completed");
  insertHandoff(db, "h2", "2026-05-04T10:00:00Z", "pending");

  const m = computeStateMetrics({ db, now, transcriptReader: nullTranscript });
  expect(m["time-since-last-handoff-min"]).toBe(10);
});

test("time-since-last-handoff-min rounds partial minutes down", () => {
  const db = freshDb();
  insertHandoff(db, "h1", "2026-05-04T11:57:30Z", "pending");

  const m = computeStateMetrics({ db, now, transcriptReader: nullTranscript });
  expect(m["time-since-last-handoff-min"]).toBe(2);
});

test("time-since-last-handoff-min clamps a future handoff ts to 0", () => {
  const db = freshDb();
  insertHandoff(db, "h1", "2026-05-04T12:30:00Z", "pending");

  const m = computeStateMetrics({ db, now, transcriptReader: nullTranscript });
  expect(m["time-since-last-handoff-min"]).toBe(0);
});

test("queue-idle-min counts only dispatch.end events", () => {
  const db = freshDb();
  insertDispatchEvent(db, "h1", "dispatch.start", "2026-05-04T11:55:00Z");
  insertDispatchEvent(db, "h1", "dispatch.end", "2026-05-04T11:00:00Z");

  const m = computeStateMetrics({ db, now, transcriptReader: nullTranscript });
  expect(m["queue-idle-min"]).toBe(60);
});

test("queue-idle-min uses the latest dispatch.end", () => {
  const db = freshDb();
  insertDispatchEvent(db, "h1", "dispatch.end", "2026-05-04T10:00:00Z");
  insertDispatchEvent(db, "h2", "dispatch.end", "2026-05-04T11:45:00Z");

  const m = computeStateMetrics({ db, now, transcriptReader: nullTranscript });
  expect(m["queue-idle-min"]).toBe(15);
});

test("queue-idle-min clamps a future dispatch.end to 0", () => {
  const db = freshDb();
  insertDispatchEvent(db, "h1", "dispatch.end", "2026-05-04T12:30:00Z");

  const m = computeStateMetrics({ db, now, transcriptReader: nullTranscript });
  expect(m["queue-idle-min"]).toBe(0);
});

test("pending-handoffs counts only status pending", () => {
  const db = freshDb();
  insertHandoff(db, "h1", "2026-05-04T10:00:00Z", "pending");
  insertHandoff(db, "h2", "2026-05-04T10:01:00Z", "completed");
  insertHandoff(db, "h3", "2026-05-04T10:02:00Z", "failed");

  const m = computeStateMetrics({ db, now, transcriptReader: nullTranscript });
  expect(m["pending-handoffs"]).toBe(1);
});

test("commits-since-last-handoff ignores non-session-handoff outcomes and never calls gitLogSince", () => {
  const db = freshDb();
  insertT0(
    db,
    "e1",
    "2026-05-04T11:00:00Z",
    "workflow.outcome",
    JSON.stringify({ workflow_name: "other-flow" }),
  );
  insertT0(
    db,
    "e2",
    "2026-05-04T11:30:00Z",
    "session.summary",
    JSON.stringify({ workflow_name: "session-handoff" }),
  );

  let called = false;
  const stub: GitLogSinceCounter = () => {
    called = true;
    return 0;
  };

  const m = computeStateMetrics({ db, now, gitLogSince: stub, transcriptReader: nullTranscript });
  expect(m["commits-since-last-handoff"]).toBe(Number.MAX_SAFE_INTEGER);
  expect(called).toBe(false);
});

test("malformed payload_json rows are skipped without throwing", () => {
  const db = freshDb();
  insertT0(
    db,
    "e1",
    "2026-05-04T10:00:00Z",
    "workflow.outcome",
    JSON.stringify({ workflow_name: "session-handoff" }),
  );
  insertT0(db, "e2", "2026-05-04T11:30:00Z", "workflow.outcome", "not json");

  let seenSince = "";
  const stub: GitLogSinceCounter = (since) => {
    seenSince = since;
    return 4;
  };

  const m = computeStateMetrics({ db, now, gitLogSince: stub, transcriptReader: nullTranscript });
  expect(seenSince).toBe("2026-05-04T10:00:00Z");
  expect(m["commits-since-last-handoff"]).toBe(4);
});

test("contextBudgetTokens overrides the 200k default", () => {
  const db = freshDb();
  const m = computeStateMetrics({
    db,
    now,
    transcriptReader: () => ({ estimatedTokens: 1000 }),
    contextBudgetTokens: 4000,
  });
  expect(m["context-window-percent"]).toBe(25);
});

test("context-window-percent rounds to the nearest integer", () => {
  const db = freshDb();
  const m = computeStateMetrics({
    db,
    now,
    transcriptReader: () => ({ estimatedTokens: 3 }),
    contextBudgetTokens: 8,
  });
  expect(m["context-window-percent"]).toBe(38);
});

test("cwd option is passed to transcriptReader", () => {
  const db = freshDb();
  let seen: string | undefined;
  const m = computeStateMetrics({
    db,
    now,
    cwd: "/tmp/poller-cwd-probe",
    transcriptReader: (o: { cwd: string }) => {
      seen = o.cwd;
      return null;
    },
  });
  expect(seen).toBe("/tmp/poller-cwd-probe");
  expect(m["context-window-percent"]).toBe(0);
});
