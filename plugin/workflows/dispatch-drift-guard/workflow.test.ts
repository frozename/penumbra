import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { fn } from "./workflow.js";

const EMPTY_RECALL = { byKey: {}, warnings: [], estimatedTokens: 0 };

let previousThreshold: string | undefined;
let previousRenag: string | undefined;

beforeEach(() => {
  previousThreshold = process.env.PENUMBRA_SOLO_DRIFT_THRESHOLD;
  previousRenag = process.env.PENUMBRA_SOLO_DRIFT_RENAG;
  process.env.PENUMBRA_SOLO_DRIFT_THRESHOLD = "2";
  process.env.PENUMBRA_SOLO_DRIFT_RENAG = "4";
});

afterEach(() => {
  if (previousThreshold === undefined) delete process.env.PENUMBRA_SOLO_DRIFT_THRESHOLD;
  else process.env.PENUMBRA_SOLO_DRIFT_THRESHOLD = previousThreshold;
  if (previousRenag === undefined) delete process.env.PENUMBRA_SOLO_DRIFT_RENAG;
  else process.env.PENUMBRA_SOLO_DRIFT_RENAG = previousRenag;
});

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE t0_events (
    session_id TEXT,
    source TEXT,
    event_type TEXT,
    payload_json TEXT,
    source_detail TEXT,
    ts TEXT
  )`);
  return db;
}

function insertTool(
  db: Database,
  sessionId: string,
  ts: string,
  tool: string,
  toolActivity: string,
  command: string | null = null,
  source = "codex",
): void {
  db.query(
    `INSERT INTO t0_events(session_id, source, event_type, payload_json, source_detail, ts)
     VALUES (?, ?, 'agent-tool-use', ?, ?, ?)`,
  ).run(
    sessionId,
    source,
    JSON.stringify({ tool, tool_activity: toolActivity, input: { command } }),
    `tool:${tool}`,
    ts,
  );
}

test("Codex harness args cannot self-qualify without verified ingress", async () => {
  const db = freshDb();
  try {
    const sessionId = "11111111-2222-4333-8444-555555555555";
    insertTool(db, sessionId, "2026-09-12T12:00:00.000Z", "Edit", "edit", null, "claude-code");
    insertTool(db, sessionId, "2026-09-12T12:00:01.000Z", "Edit", "edit", null, "claude-code");

    const reminder = await fn(
      { storageRoot: "/unused", args: { db, session_id: sessionId, harness: "codex" } } as never,
      EMPTY_RECALL,
    );
    expect(reminder).toBe("");
  } finally {
    db.close();
  }
});

function codexArgs(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    session_id: sessionId,
    harness: "codex",
    lineage: "root",
    ingress: {
      harness: "codex",
      role: "maestro",
      lineage: "root",
      provenance: "verified-session-correlation",
      is_child: false,
      parent_session_id: null,
    },
    ...overrides,
  };
}

test("Codex drift uses explicit maestro-root ingress and semantic tool activity", async () => {
  const db = freshDb();
  try {
    insertTool(db, "opaque-root", "2026-09-12T12:00:00.000Z", "apply_patch", "edit");
    insertTool(
      db,
      "opaque-root",
      "2026-09-12T12:00:01.000Z",
      "mcp__penumbra__workflow_wait",
      "other",
    );
    insertTool(db, "opaque-root", "2026-09-12T12:00:02.000Z", "edit", "edit");

    const reminder = await fn(
      {
        storageRoot: "/unused",
        args: { ...codexArgs("opaque-root"), db },
      } as never,
      EMPTY_RECALL,
    );
    expect(reminder).toContain("dispatch-drift: 2 consecutive");

    const child = await fn(
      {
        storageRoot: "/unused",
        args: {
          ...codexArgs("opaque-root", {
            lineage: "child",
            ingress: {
              harness: "codex",
              role: "dispatch",
              lineage: "child",
              provenance: "verified-launch",
              is_child: true,
              parent_session_id: "opaque-root",
            },
          }),
          db,
        },
      } as never,
      EMPTY_RECALL,
    );
    expect(child).toBe("");
  } finally {
    db.close();
  }
});

test("structured Codex fleet dispatch resets the trailing edit streak", async () => {
  const db = freshDb();
  try {
    insertTool(db, "opaque-reset", "2026-09-12T12:00:00.000Z", "apply_patch", "edit");
    insertTool(db, "opaque-reset", "2026-09-12T12:00:01.000Z", "edit", "edit");
    insertTool(
      db,
      "opaque-reset",
      "2026-09-12T12:00:02.000Z",
      "mcp__penumbra__chain_start",
      "fleet-dispatch",
    );

    const reminder = await fn(
      {
        storageRoot: "/unused",
        args: { ...codexArgs("opaque-reset"), db },
      } as never,
      EMPTY_RECALL,
    );
    expect(reminder).toBe("");
  } finally {
    db.close();
  }
});
