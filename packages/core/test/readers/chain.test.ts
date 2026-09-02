import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { ChainReader } from "@src/readers/chain.js";
import type { HandoffStatus } from "@src/schemas/handoff.js";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;
let reader: ChainReader;

const baseTs = Date.parse("2026-05-05T00:00:00.000Z");

function isoAt(offsetMs: number): string {
  return new Date(baseTs + offsetMs).toISOString();
}

function insertHandoff(opts: {
  handoff_id: string;
  ts: string;
  conversation_id: string;
  project_id?: string | null;
  parent_handoff_id?: string | null;
  status?: HandoffStatus;
  to_agent?: string;
  to_role?: string | null;
}): void {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role,
       message, status, triggered_by_event_id, parent_handoff_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.handoff_id,
      opts.ts,
      opts.project_id ?? null,
      opts.conversation_id,
      "user",
      opts.to_agent ?? "codex",
      opts.to_role ?? null,
      `msg-${opts.handoff_id}`,
      opts.status ?? "approved",
      `ev-${opts.handoff_id}`,
      opts.parent_handoff_id ?? null,
    ],
  );
}

function insertEvent(opts: {
  event_id: string;
  ts: string;
  session_id: string;
  event_type: string;
  source?: string;
  source_detail?: string | null;
  user_id?: string | null;
  payload_json?: string;
  ingest_ts?: string;
}): void {
  db.run(
    `INSERT INTO t0_events (
       event_id, ts, ingest_ts, source, source_detail, project_id, user_id,
       machine_id, session_id, event_type, lane, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.event_id,
      opts.ts,
      opts.ingest_ts ?? opts.ts,
      opts.source ?? "agentchat",
      opts.source_detail ?? null,
      null,
      opts.user_id ?? "u1",
      "m1",
      opts.session_id,
      opts.event_type,
      "local",
      opts.payload_json ?? "{}",
    ],
  );
}

// The legacy query the rewrite is replacing. Kept verbatim here so the
// test can assert that the new implementation returns the EXACT same rows
// for a multi-conversation fixture. If this test fails after a future
// rewrite, the rewrite has changed observable behavior.
function listChainsLegacy(opts: {
  status?: HandoffStatus;
  project_id?: string;
  limit: number;
  offset: number;
}): unknown[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) {
    where.push(`latest_status = ?`);
    params.push(opts.status);
  }
  if (opts.project_id) {
    where.push(`(project_id = ? OR project_id IS NULL)`);
    params.push(opts.project_id);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT
      conversation_id,
      project_id,
      latest_status,
      latest_ts,
      earliest_ts,
      handoff_count,
      root_handoff_id,
      to_agent,
      to_role
    FROM (
      SELECT
        h.conversation_id AS conversation_id,
        (SELECT project_id FROM handoffs WHERE conversation_id = h.conversation_id ORDER BY ts DESC LIMIT 1) AS project_id,
        (SELECT status FROM handoffs WHERE conversation_id = h.conversation_id ORDER BY ts DESC LIMIT 1) AS latest_status,
        MAX(h.ts) AS latest_ts,
        MIN(h.ts) AS earliest_ts,
        COUNT(*) AS handoff_count,
        (SELECT handoff_id FROM handoffs WHERE conversation_id = h.conversation_id AND parent_handoff_id IS NULL ORDER BY ts ASC LIMIT 1) AS root_handoff_id,
        (SELECT to_agent FROM handoffs WHERE conversation_id = h.conversation_id ORDER BY ts DESC LIMIT 1) AS to_agent,
        (SELECT to_role FROM handoffs WHERE conversation_id = h.conversation_id ORDER BY ts DESC LIMIT 1) AS to_role
      FROM handoffs h
      GROUP BY h.conversation_id
    )
    ${whereClause}
    ORDER BY latest_ts DESC
    LIMIT ? OFFSET ?
  `;
  params.push(opts.limit, opts.offset);
  return db.query(sql).all(...params);
}

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  reader = new ChainReader(db);
});

test("listChains returns one summary per conversation, latest first", () => {
  insertHandoff({
    handoff_id: "h-old",
    ts: isoAt(0),
    conversation_id: "c-old",
    project_id: "p1",
    status: "completed",
  });
  insertHandoff({
    handoff_id: "h-new-1",
    ts: isoAt(1000),
    conversation_id: "c-new",
    project_id: "p2",
    status: "approved",
    to_agent: "claude",
    to_role: "implementer",
  });
  insertHandoff({
    handoff_id: "h-new-2",
    ts: isoAt(2000),
    conversation_id: "c-new",
    project_id: "p2",
    parent_handoff_id: "h-new-1",
    status: "dispatched",
    to_agent: "codex",
    to_role: "reviewer",
  });

  const rows = reader.listChains({ limit: 10, offset: 0 });
  expect(rows.map((r) => r.conversation_id)).toEqual(["c-new", "c-old"]);
  const cNew = rows.find((r) => r.conversation_id === "c-new");
  expect(cNew?.handoff_count).toBe(2);
  expect(cNew?.latest_status).toBe("dispatched");
  expect(cNew?.to_agent).toBe("codex");
  expect(cNew?.to_role).toBe("reviewer");
  expect(cNew?.root_handoff_id).toBe("h-new-1");
  expect(cNew?.earliest_ts).toBe(isoAt(1000));
  expect(cNew?.latest_ts).toBe(isoAt(2000));
});

test("listChains rewrite matches legacy query result-for-result on a multi-conversation fixture", () => {
  // Conversation c-a: 3 handoffs, mixed statuses, with a root.
  insertHandoff({
    handoff_id: "a1",
    ts: isoAt(100),
    conversation_id: "c-a",
    project_id: "p-a",
    status: "completed",
    to_agent: "codex",
  });
  insertHandoff({
    handoff_id: "a2",
    ts: isoAt(200),
    conversation_id: "c-a",
    project_id: "p-a",
    parent_handoff_id: "a1",
    status: "completed",
    to_agent: "claude",
    to_role: "reviewer",
  });
  insertHandoff({
    handoff_id: "a3",
    ts: isoAt(300),
    conversation_id: "c-a",
    project_id: "p-a",
    parent_handoff_id: "a2",
    status: "failed",
    to_agent: "gemini",
  });

  // Conversation c-b: 2 handoffs, NULL project_id on latest.
  insertHandoff({
    handoff_id: "b1",
    ts: isoAt(400),
    conversation_id: "c-b",
    project_id: "p-b",
    status: "approved",
    to_agent: "codex",
  });
  insertHandoff({
    handoff_id: "b2",
    ts: isoAt(500),
    conversation_id: "c-b",
    project_id: null,
    parent_handoff_id: "b1",
    status: "dispatched",
    to_agent: "claude",
  });

  // Conversation c-c: single handoff.
  insertHandoff({
    handoff_id: "c1",
    ts: isoAt(600),
    conversation_id: "c-c",
    project_id: "p-a",
    status: "approved",
    to_agent: "codex",
  });

  // Conversation c-d: no root (every handoff has a parent — pathological,
  // but exercises root_handoff_id LEFT JOIN behavior).
  insertHandoff({
    handoff_id: "d1",
    ts: isoAt(700),
    conversation_id: "c-d",
    project_id: "p-d",
    parent_handoff_id: "external",
    status: "approved",
    to_agent: "codex",
  });

  const cases: {
    status?: HandoffStatus;
    project_id?: string;
    limit: number;
    offset: number;
  }[] = [
    { limit: 100, offset: 0 },
    { limit: 2, offset: 0 },
    { limit: 2, offset: 2 },
    { status: "completed", limit: 100, offset: 0 },
    { status: "approved", limit: 100, offset: 0 },
    { project_id: "p-a", limit: 100, offset: 0 },
    { project_id: "p-a", status: "approved", limit: 100, offset: 0 },
  ];

  for (const c of cases) {
    const legacy = listChainsLegacy(c);
    const rewritten = reader.listChains(c);
    expect(rewritten).toEqual(legacy as ReturnType<typeof reader.listChains>);
  }
});

test("listChains returns empty result on empty handoffs table", () => {
  const rows = reader.listChains({ limit: 100, offset: 0 });
  expect(rows).toEqual([]);
});

test("getMessages applies high default limit but does not truncate normal reads", () => {
  for (let i = 0; i < 5; i++) {
    insertEvent({
      event_id: `ev-${String(i)}`,
      ts: isoAt(i),
      session_id: "c1",
      event_type: "user-prompt",
      payload_json: JSON.stringify({ n: i }),
    });
  }
  const events = reader.getMessages("c1");
  expect(events.length).toBe(5);
  expect(events.map((e) => e.event_id)).toEqual(["ev-0", "ev-1", "ev-2", "ev-3", "ev-4"]);
});

test("getMessages honors explicit limit and offset for pagination", () => {
  for (let i = 0; i < 6; i++) {
    insertEvent({
      event_id: `ev-${String(i)}`,
      ts: isoAt(i),
      session_id: "c1",
      event_type: "user-prompt",
    });
  }
  const page1 = reader.getMessages("c1", undefined, { limit: 2, offset: 0 });
  const page2 = reader.getMessages("c1", undefined, { limit: 2, offset: 2 });
  expect(page1.map((e) => e.event_id)).toEqual(["ev-0", "ev-1"]);
  expect(page2.map((e) => e.event_id)).toEqual(["ev-2", "ev-3"]);
});

test("getMessages caps pathological conversations at the safe default", () => {
  for (let i = 0; i < 1500; i++) {
    insertEvent({
      event_id: `ev-${i.toString().padStart(5, "0")}`,
      ts: isoAt(i),
      session_id: "c-big",
      event_type: "agent-tool-use",
    });
  }
  const events = reader.getMessages("c-big");
  expect(events.length).toBe(1000);
  expect(events[0]?.event_id).toBe("ev-00000");
});

test("getMessages before_ts cursor returns only events strictly before the cursor", () => {
  for (let i = 0; i < 5; i++) {
    insertEvent({
      event_id: `ev-${String(i)}`,
      ts: isoAt(i),
      session_id: "c1",
      event_type: "user-prompt",
    });
  }
  const cutoff = isoAt(3);
  const events = reader.getMessages("c1", undefined, { before_ts: cutoff });
  expect(events.map((e) => e.event_id)).toEqual(["ev-0", "ev-1", "ev-2"]);
});

test("getMessages with types filter combines with limit", () => {
  insertEvent({
    event_id: "ev-1",
    ts: isoAt(1),
    session_id: "c1",
    event_type: "user-prompt",
  });
  insertEvent({
    event_id: "ev-2",
    ts: isoAt(2),
    session_id: "c1",
    event_type: "agent-response",
  });
  insertEvent({
    event_id: "ev-3",
    ts: isoAt(3),
    session_id: "c1",
    event_type: "agent-response",
  });
  const events = reader.getMessages("c1", ["agent-response"], { limit: 10 });
  expect(events.length).toBe(2);
  expect(events.every((e) => e.event_type === "agent-response")).toBe(true);
});

test("getResponses returns each response handoff_id and scopes by handoff_id", () => {
  insertEvent({
    event_id: "ev-hop-1",
    ts: isoAt(1),
    session_id: "c-hop",
    event_type: "agent-response",
    user_id: "planner",
    payload_json: JSON.stringify({ response: "first hop", handoff_id: "h-first" }),
  });
  insertEvent({
    event_id: "ev-hop-2",
    ts: isoAt(2),
    session_id: "c-hop",
    event_type: "agent-response",
    user_id: "executor",
    payload_json: JSON.stringify({ response: "second hop", handoff_id: "h-second" }),
  });

  const all = reader.getResponses("c-hop", "all");
  expect(all.map((response) => response.handoff_id)).toEqual(["h-first", "h-second"]);

  const scoped = reader.getResponses("c-hop", "all", { handoff_id: "h-first" });
  expect(scoped).toEqual([
    {
      agent: "planner",
      text: "first hop",
      ts: isoAt(1),
      handoff_id: "h-first",
    },
  ]);
});

test("getResponses all collapses segment rows into the turn row; final keeps it", () => {
  insertEvent({
    event_id: "ev-hop-seg-a",
    ts: isoAt(1),
    session_id: "c-hop",
    event_type: "agent-response",
    payload_json: JSON.stringify({ text: "A", handoff_id: "h-1" }),
  });
  insertEvent({
    event_id: "ev-hop-seg-b",
    ts: isoAt(2),
    session_id: "c-hop",
    event_type: "agent-response",
    payload_json: JSON.stringify({ text: "B", handoff_id: "h-1" }),
  });
  insertEvent({
    event_id: "ev-hop-turn",
    ts: isoAt(3),
    session_id: "c-hop",
    event_type: "agent-response",
    payload_json: JSON.stringify({ response: "AB", handoff_id: "h-1" }),
  });

  expect(reader.getResponses("c-hop", "all").map((response) => response.text)).toEqual(["AB"]);
  expect(reader.getResponses("c-hop", "final")[0]?.text).toBe("AB");
});

test("getResponses all collapses byte-identical segment twins into the turn row", () => {
  insertEvent({
    event_id: "ev-twin-seg",
    ts: isoAt(1),
    session_id: "c-twin",
    event_type: "agent-response",
    payload_json: JSON.stringify({ text: "X", handoff_id: "h-twin" }),
  });
  insertEvent({
    event_id: "ev-twin-turn",
    ts: isoAt(2),
    session_id: "c-twin",
    event_type: "agent-response",
    payload_json: JSON.stringify({ response: "X", handoff_id: "h-twin" }),
  });

  expect(reader.getResponses("c-twin", "all").map((response) => response.text)).toEqual(["X"]);
});

test("getResponses all keeps turn-only capture-only and error rows", () => {
  insertEvent({
    event_id: "ev-turn-only",
    ts: isoAt(1),
    session_id: "c-turn-only",
    event_type: "agent-response",
    payload_json: JSON.stringify({ response: "Y", handoff_id: "h-turn-only" }),
  });
  expect(reader.getResponses("c-turn-only", "all").map((response) => response.text)).toEqual(["Y"]);

  insertEvent({
    event_id: "ev-capture-only-1",
    ts: isoAt(1),
    session_id: "c-capture-only",
    event_type: "agent-response",
    payload_json: JSON.stringify({ text: "S1", handoff_id: "h-capture-only" }),
  });
  insertEvent({
    event_id: "ev-capture-only-2",
    ts: isoAt(2),
    session_id: "c-capture-only",
    event_type: "agent-response",
    payload_json: JSON.stringify({ text: "S2", handoff_id: "h-capture-only" }),
  });
  expect(reader.getResponses("c-capture-only", "all").map((response) => response.text)).toEqual([
    "S1",
    "S2",
  ]);

  insertEvent({
    event_id: "ev-error-seg",
    ts: isoAt(1),
    session_id: "c-error",
    event_type: "agent-response",
    payload_json: JSON.stringify({ text: "seg", handoff_id: "h-error" }),
  });
  insertEvent({
    event_id: "ev-error-turn",
    ts: isoAt(2),
    session_id: "c-error",
    event_type: "agent-response",
    payload_json: JSON.stringify({ error: "boom", handoff_id: "h-error" }),
  });

  const errorRows = reader.getResponses("c-error", "all");
  expect(errorRows.map((response) => response.text)).toEqual(["seg", ""]);
  expect(errorRows[1]?.error?.message).toBe("boom");
});

test("getResponses final demotes capture segments without outranking later errors", () => {
  insertEvent({
    event_id: "ev-final-turn",
    ts: isoAt(1),
    session_id: "c-final-turn",
    event_type: "agent-response",
    payload_json: JSON.stringify({ response: "R", handoff_id: "h-final-turn" }),
  });
  insertEvent({
    event_id: "ev-final-segment",
    ts: isoAt(2),
    session_id: "c-final-turn",
    event_type: "agent-response",
    payload_json: JSON.stringify({ text: "seg", handoff_id: "h-final-turn" }),
  });
  expect(reader.getResponses("c-final-turn", "final")[0]?.text).toBe("R");

  insertEvent({
    event_id: "ev-final-partial",
    ts: isoAt(1),
    session_id: "c-final-error",
    event_type: "agent-response",
    payload_json: JSON.stringify({ text: "partial", handoff_id: "h-final-error" }),
  });
  insertEvent({
    event_id: "ev-final-error",
    ts: isoAt(2),
    session_id: "c-final-error",
    event_type: "agent-response",
    payload_json: JSON.stringify({ error: "boom", handoff_id: "h-final-error" }),
  });
  const errorRow = reader.getResponses("c-final-error", "final")[0];
  expect(errorRow?.text).toBe("");
  expect(errorRow?.error?.message).toBe("boom");

  insertEvent({
    event_id: "ev-final-r1",
    ts: isoAt(1),
    session_id: "c-final-retry-error",
    event_type: "agent-response",
    payload_json: JSON.stringify({ response: "R1", handoff_id: "h-final-retry-error" }),
  });
  insertEvent({
    event_id: "ev-final-e",
    ts: isoAt(2),
    session_id: "c-final-retry-error",
    event_type: "agent-response",
    payload_json: JSON.stringify({ error: "E", handoff_id: "h-final-retry-error" }),
  });
  const retryErrorRow = reader.getResponses("c-final-retry-error", "final")[0];
  expect(retryErrorRow?.text).toBe("");
  expect(retryErrorRow?.error?.message).toBe("E");
});

test("getResponses with handoff_id does not fall back to unstamped sibling rows", () => {
  insertEvent({
    event_id: "ev-unstamped-sibling",
    ts: isoAt(1),
    session_id: "c-hop",
    event_type: "agent-response",
    user_id: "sibling",
    payload_json: JSON.stringify({ response: "sibling output" }),
  });

  const scoped = reader.getResponses("c-hop", "all", { handoff_id: "h-requested" });

  expect(scoped).toEqual([]);
});

test("getResponses with handoff_id returns only exact matching rows", () => {
  insertEvent({
    event_id: "ev-hop-1",
    ts: isoAt(1),
    session_id: "c-hop",
    event_type: "agent-response",
    user_id: "planner",
    payload_json: JSON.stringify({ response: "first hop", handoff_id: "h-first" }),
  });
  insertEvent({
    event_id: "ev-hop-2",
    ts: isoAt(2),
    session_id: "c-hop",
    event_type: "agent-response",
    user_id: "executor",
    payload_json: JSON.stringify({ response: "second hop", handoff_id: "h-second" }),
  });
  insertEvent({
    event_id: "ev-unstamped",
    ts: isoAt(3),
    session_id: "c-hop",
    event_type: "agent-response",
    user_id: "legacy",
    payload_json: JSON.stringify({ response: "legacy unstamped" }),
  });

  const scoped = reader.getResponses("c-hop", "all", { handoff_id: "h-second" });

  expect(scoped).toEqual([
    {
      agent: "executor",
      text: "second hop",
      ts: isoAt(2),
      handoff_id: "h-second",
    },
  ]);
});

test("getResponses final with handoff_id returns that hop latest response", () => {
  insertEvent({
    event_id: "ev-hop-1-old",
    ts: isoAt(1),
    session_id: "c-hop",
    event_type: "agent-response",
    user_id: "planner",
    payload_json: JSON.stringify({ response: "first hop old", handoff_id: "h-first" }),
  });
  insertEvent({
    event_id: "ev-hop-1-new",
    ts: isoAt(2),
    session_id: "c-hop",
    event_type: "agent-response",
    user_id: "planner",
    payload_json: JSON.stringify({ response: "first hop new", handoff_id: "h-first" }),
  });
  insertEvent({
    event_id: "ev-hop-2",
    ts: isoAt(3),
    session_id: "c-hop",
    event_type: "agent-response",
    user_id: "executor",
    payload_json: JSON.stringify({ response: "later second hop", handoff_id: "h-second" }),
  });

  const scoped = reader.getResponses("c-hop", "final", { handoff_id: "h-first" });

  expect(scoped).toEqual([
    {
      agent: "planner",
      text: "first hop new",
      ts: isoAt(2),
      handoff_id: "h-first",
    },
  ]);
});
