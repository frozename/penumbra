import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, migrate } from "@penumbra/core";
import { TaskDraftReader } from "@penumbra/core";
import {
  taskDraftsPendingEscalationsRoute,
  taskDraftsPendingRoute,
} from "../../src/routes/task-drafts.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function freshDb() {
  const db = new Database(":memory:");
  try {
    loadSqliteVec(db);
  } catch {
    // extension loading is not available in every Bun build
  }
  migrate(db, { embeddingDim: 4 });
  return db;
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
  const res = await taskDraftsPendingRoute(req, services as never);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { drafts: Array<{ event_id: string }> };
  expect(body.drafts).toHaveLength(1);
  expect(body.drafts[0]!.event_id).toBe("e1");
});

test("GET /task-drafts/pending returns 400 on invalid latest_event_type", async () => {
  const db = freshDb();
  const services = { db, taskDraftReader: new TaskDraftReader({ db }) };
  const req = new Request("http://localhost/task-drafts/pending?latest_event_type=bogus");
  const res = await taskDraftsPendingRoute(req, services as never);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("validation_error");
});

test("GET /task-drafts/pending returns 400 when project_id is missing or empty", async () => {
  const db = freshDb();
  const services = { db, taskDraftReader: new TaskDraftReader({ db }) };

  const missing = await taskDraftsPendingRoute(
    new Request("http://localhost/task-drafts/pending?latest_event_type=task_draft"),
    services as never,
  );
  expect(missing.status).toBe(400);

  const empty = await taskDraftsPendingRoute(
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
  const res = await taskDraftsPendingEscalationsRoute(req, services as never);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    escalations: Array<{ event_id: string; prompt: string; escalation_reason: string }>;
  };
  expect(body.escalations).toHaveLength(1);
  expect(body.escalations[0]).toMatchObject({
    event_id: "escalation",
    prompt: "p",
    escalation_reason: "needs review",
  });
});

test("GET /task-drafts/pending-escalations returns 400 when project_id is missing", async () => {
  const db = freshDb();
  const services = { db, taskDraftReader: new TaskDraftReader({ db }) };
  const res = await taskDraftsPendingEscalationsRoute(
    new Request("http://localhost/task-drafts/pending-escalations"),
    services as never,
  );
  expect(res.status).toBe(400);
});
