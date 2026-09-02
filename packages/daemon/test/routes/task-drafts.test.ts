import {
  DEFAULT_REDACTION_RULES,
  loadSqliteVec,
  migrate,
  RegexRedactor,
  T0Writer,
  TaskDraftReader,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { observationsRoute } from "@src/routes/observations.js";
import {
  taskDraftsPendingEscalationsRoute,
  taskDraftsPendingRoute,
} from "@src/routes/task-drafts.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function freshDb(): Database {
  const db = new Database(":memory:");
  try {
    loadSqliteVec(db);
  } catch {
    // extension loading is not available in every Bun build
  }
  migrate(db, { embeddingDim: 4 });
  return db;
}

const capturedLongLivedTickStatusPayloads = [
  {
    tick_id: "8fde299d-1006-4edf-a866-121ee4a5eabf",
    status: "tick_start",
  },
  {
    tick_id: "6441b4e4-83da-4a5f-8cf4-fd49cea27654",
    status: "idle",
    reason: "no pending drafts, state tools unavailable",
    drafts_pending: 0,
    task_pending_total: 7,
  },
] as const;

function observationServices(db: Database): {
  db: Database;
  taskDraftReader: TaskDraftReader;
  t0Writer: T0Writer;
  machineId: { get(): string };
  clock(): Date;
  uuid(): string;
  redactor: RegexRedactor;
} {
  return {
    db,
    taskDraftReader: new TaskDraftReader({ db }),
    t0Writer: new T0Writer(db),
    machineId: { get: () => "m" },
    clock: () => new Date("2026-08-18T21:20:00.000Z"),
    uuid: () => "generated-event-id",
    redactor: new RegexRedactor(DEFAULT_REDACTION_RULES),
  };
}

test("GET /task-drafts/pending returns pending drafts and validates params", async () => {
  const db = freshDb();
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, project_id, user_id, machine_id, event_type, lane, payload_json)
     VALUES ('e1', '2026-05-16T00:00:00.000Z', '2026-05-16T00:00:01.000Z', 'mcp', 'p1', 'u', 'm', 'task_draft', 'unknown',
             '{"draft_id":"11111111-1111-4111-8111-111111111111","prompt":"p","affects_projects":["a"],"evidence":{},"auto_ok":true,"filed_by_agent":"agent","filed_via":"skill_inline","parent_draft_id":null}')`,
  );
  const services = { db, taskDraftReader: new TaskDraftReader({ db }) };
  const req = new Request(
    "http://localhost/task-drafts/pending?latest_event_type=task_draft&project_id=p1&limit=5",
  );
  const res = taskDraftsPendingRoute(req, services as never);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { drafts: { event_id: string }[] };
  expect(body.drafts).toHaveLength(1);
  expect(body.drafts[0]!.event_id).toBe("e1");
});

test("POST /observations remaps captured long-lived tick status payloads out of task_draft", async () => {
  const db = freshDb();
  const services = observationServices(db);

  for (const [index, payload] of capturedLongLivedTickStatusPayloads.entries()) {
    const res = await observationsRoute(
      new Request("http://localhost/observations", {
        method: "POST",
        body: JSON.stringify({
          event_id: `tick-status-${String(index + 1)}`,
          ts: "2026-08-18T12:00:00.008Z",
          ingest_ts: "2026-08-18T12:00:00.008Z",
          source: "mcp",
          user_id: "mcp-client",
          machine_id: "mcp-client",
          event_type: "task_draft",
          lane: "unknown",
          payload_json: payload,
        }),
      }),
      services as never,
    );
    expect(res.status).toBe(200);
  }

  const rows = db
    .query<{ event_id: string; event_type: string; payload_json: string }, []>(
      `SELECT event_id, event_type, payload_json
       FROM t0_events
       WHERE event_id LIKE 'tick-status-%'
       ORDER BY event_id`,
    )
    .all();
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.event_type)).toEqual([
    "long_lived.tick.status",
    "long_lived.tick.status",
  ]);
  expect(JSON.parse(rows[0]!.payload_json)).toEqual(capturedLongLivedTickStatusPayloads[0]);
  expect(JSON.parse(rows[1]!.payload_json)).toEqual(capturedLongLivedTickStatusPayloads[1]);

  const polluted = db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) AS count
       FROM t0_events
       WHERE event_type = 'task_draft'
         AND json_extract(payload_json, '$.tick_id') IS NOT NULL`,
    )
    .get();
  expect(polluted?.count).toBe(0);
});

test("GET /task-drafts/pending returns 400 on invalid latest_event_type", async () => {
  const db = freshDb();
  const services = { db, taskDraftReader: new TaskDraftReader({ db }) };
  const req = new Request("http://localhost/task-drafts/pending?latest_event_type=bogus");
  const res = taskDraftsPendingRoute(req, services as never);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("validation_error");
});

test("POST /observations ignores client-supplied ingest_ts and uses server clock", async () => {
  const db = freshDb();
  const services = observationServices(db);
  const clientIngestTs = "2026-01-01T00:00:00.000Z";
  const res = await observationsRoute(
    new Request("http://localhost/observations", {
      method: "POST",
      body: JSON.stringify({
        event_id: "evt-client-ingest",
        ts: "2026-08-18T12:00:00.000Z",
        ingest_ts: clientIngestTs,
        source: "mcp",
        user_id: "mcp-client",
        machine_id: "mcp-client",
        event_type: "agent-thought",
        lane: "unknown",
        payload_json: { thought: "test" },
      }),
    }),
    services as never,
  );
  expect(res.status).toBe(200);
  const row = db
    .query<
      { ingest_ts: string },
      []
    >(`SELECT ingest_ts FROM t0_events WHERE event_id = 'evt-client-ingest'`)
    .get();
  expect(row?.ingest_ts).toBe(services.clock().toISOString());
  expect(row?.ingest_ts).not.toBe(clientIngestTs);
});

test("GET /task-drafts/pending returns 400 when project_id is missing or empty", () => {
  const db = freshDb();
  const services = { db, taskDraftReader: new TaskDraftReader({ db }) };

  const missing = taskDraftsPendingRoute(
    new Request("http://localhost/task-drafts/pending?latest_event_type=task_draft"),
    services as never,
  );
  expect(missing.status).toBe(400);

  const empty = taskDraftsPendingRoute(
    new Request("http://localhost/task-drafts/pending?latest_event_type=task_draft&project_id="),
    services as never,
  );
  expect(empty.status).toBe(400);
});

test("GET /task-drafts/pending-escalations returns escalations and validates params", async () => {
  const db = freshDb();
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, project_id, user_id, machine_id, event_type, lane, payload_json)
     VALUES
       ('draft', '2026-05-16T00:00:00.000Z', '2026-05-16T00:00:01.000Z', 'mcp', 'p1', 'u', 'm', 'task_draft', 'unknown',
        '{"draft_id":"11111111-1111-4111-8111-111111111111","prompt":"p","affects_projects":["a"],"evidence":{},"auto_ok":true,"filed_by_agent":"agent","filed_via":"skill_inline","parent_draft_id":null}'),
       ('escalation', '2026-05-16T00:01:00.000Z', '2026-05-16T00:01:01.000Z', 'mcp', 'p1', 'u', 'm', 'task_draft_escalation', 'unknown',
        '{"draft_id":"11111111-1111-4111-8111-111111111111","escalation_reason":"needs review"}')`,
  );
  const services = { db, taskDraftReader: new TaskDraftReader({ db }) };
  const req = new Request("http://localhost/task-drafts/pending-escalations?project_id=p1&limit=5");
  const res = taskDraftsPendingEscalationsRoute(req, services as never);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    escalations: { event_id: string; prompt: string; escalation_reason: string }[];
  };
  expect(body.escalations).toHaveLength(1);
  expect(body.escalations[0]).toMatchObject({
    event_id: "escalation",
    prompt: "p",
    escalation_reason: "needs review",
  });
});

test("GET /task-drafts/pending-escalations returns 400 when project_id is missing", () => {
  const db = freshDb();
  const services = { db, taskDraftReader: new TaskDraftReader({ db }) };
  const res = taskDraftsPendingEscalationsRoute(
    new Request("http://localhost/task-drafts/pending-escalations"),
    services as never,
  );
  expect(res.status).toBe(400);
});
