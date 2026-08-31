import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  buildRegistry,
  evaluateTriggerEvent,
  type WorkflowCtx,
} from "../../../packages/workflows/src/index.js";
import { fn } from "./workflow.js";

type Candidate = {
  action: "create" | "update";
  slug: string;
  update_existing_slug?: string;
  title: string;
  body: string;
  hook: string;
  why: string;
  backlinks: string[];
};

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE t0_events (
      event_id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      project_id TEXT,
      session_id TEXT,
      event_type TEXT NOT NULL,
      payload_summary TEXT,
      payload_json TEXT
    );

    CREATE TABLE t2_memories (
      memory_id TEXT PRIMARY KEY,
      title TEXT
    );
  `);
  return db;
}

function insertEvent(
  db: Database,
  row: {
    id: string;
    sessionId: string;
    eventType: "agent-prompt" | "agent-response" | "tool";
    summary: string;
    projectId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO t0_events (
      event_id, ts, project_id, session_id, event_type, payload_summary, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    `2026-06-11T12:00:0${row.id.slice(-1)}Z`,
    row.projectId ?? "penumbra",
    row.sessionId,
    row.eventType,
    row.summary,
    null,
  );
}

function makeCtx(db: Database, args: Record<string, unknown> = {}): WorkflowCtx {
  return {
    config: {},
    cwd: "/repo/penumbra",
    storageRoot: "/tmp/penumbra-test",
    project: "penumbra",
    args: { session_id: "session-1", project_id: "penumbra", ...args },
    db: () => db,
    dispatch: async () => ({ conversation_id: "conversation", handoff_id: "handoff" }),
    awaitChain: async () => ({ status: "timeout", final_agent: null, response_text: null }),
    fileWrite: async () => "/tmp/out",
  } as WorkflowCtx;
}

function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("renders session memory candidates without writing t2", async () => {
  const db = freshDb();
  const longPrompt =
    "We decided the session memory sweep must only propose t2 writes and let approval mode perform durable writes later. ".repeat(
      2,
    );
  insertEvent(db, {
    id: "e1",
    sessionId: "session-1",
    eventType: "agent-prompt",
    summary: longPrompt,
  });
  insertEvent(db, {
    id: "e2",
    sessionId: "session-1",
    eventType: "agent-response",
    summary: "The workflow should call the daemon extraction route and render approval blocks.",
  });
  insertEvent(db, {
    id: "e3",
    sessionId: "session-1",
    eventType: "agent-response",
    summary: "No memory_write_t2 call belongs in the workflow function itself.",
  });

  const candidates: Candidate[] = [
    {
      action: "create",
      slug: "proposal-only-session-sweep",
      title: "Proposal-only session sweep",
      body: "The session-memory-sweep workflow proposes memories only; approved writes happen in the workflow script approval mode.",
      hook: "When close-time memory extraction runs",
      why: "Future sessions need to preserve the approval boundary.",
      backlinks: ["m1"],
    },
    {
      action: "update",
      slug: "close-time-memory-approval",
      update_existing_slug: "existing-close-time-memory-approval",
      title: "Close-time memory approval",
      body: "Update candidates should preserve the existing slug returned by session extraction dedupe.",
      hook: "When session extraction returns action update",
      why: "The renderer must not collapse update proposals into creates.",
      backlinks: [],
    },
  ];

  const result = await withEnv("PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS", "3", () =>
    fn(
      makeCtx(db, {
        extractSessionCandidates: async () => ({ candidates }),
      }),
      { byKey: {}, warnings: [] },
    ),
  );

  expect(result).toContain("## Session memory candidates");
  expect(result).toContain("Proposal-only session sweep");
  expect(result).toContain("Close-time memory approval");
  expect(result).toContain("[create]");
  expect(result).toContain("[update]");
  expect(result).toContain("existing-close-time-memory-approval");
  const t2Rows = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM t2_memories").get();
  expect(t2Rows?.count).toBe(0);
});

test("renders no-candidates marker when extraction returns no candidates", async () => {
  const db = freshDb();
  insertEvent(db, {
    id: "e1",
    sessionId: "session-1",
    eventType: "agent-prompt",
    summary:
      "Close-time memory sweep needs a non-empty next-session prompt section even when extraction finds nothing durable. ".repeat(
        2,
      ),
  });
  insertEvent(db, {
    id: "e2",
    sessionId: "session-1",
    eventType: "agent-response",
    summary:
      "The workflow should write an explicit no-candidates marker instead of tripping the required output sink.",
  });
  insertEvent(db, {
    id: "e3",
    sessionId: "session-1",
    eventType: "agent-response",
    summary: "That keeps session close handoff output observable without creating t2 rows.",
  });

  const result = await withEnv("PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS", "3", () =>
    fn(
      makeCtx(db, {
        extractSessionCandidates: async () => ({ candidates: [] }),
      }),
      { byKey: {}, warnings: [] },
    ),
  );

  expect(result).toBe("no new candidates");
  const t2Rows = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM t2_memories").get();
  expect(t2Rows?.count).toBe(0);
});

test("returns preserve marker for an empty db", async () => {
  const db = freshDb();
  const result = await fn(
    makeCtx(db, {
      extractSessionCandidates: async () => {
        throw new Error("extract route should not be called for empty transcripts");
      },
    }),
    { byKey: {}, warnings: [] },
  );
  expect(result).toBe("<!-- penumbra:preserve-next-session-prompt -->");
});

test("returns preserve marker when the session is below the promotion event threshold", async () => {
  const db = freshDb();
  insertEvent(db, {
    id: "e1",
    sessionId: "session-1",
    eventType: "agent-prompt",
    summary: "A long enough prompt ".repeat(20),
  });
  insertEvent(db, {
    id: "e2",
    sessionId: "session-1",
    eventType: "agent-response",
    summary: "A long enough response ".repeat(20),
  });

  const result = await withEnv("PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS", "3", () =>
    fn(
      makeCtx(db, {
        extractSessionCandidates: async () => {
          throw new Error("extract route should not be called below minEvents");
        },
      }),
      { byKey: {}, warnings: [] },
    ),
  );

  expect(result).toBe("<!-- penumbra:preserve-next-session-prompt -->");
});

test("registers pre-compact and stop lifecycle triggers", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-memory-sweep-reg-"));
  try {
    const workflowsDir = join(root, "workflows");
    mkdirSync(join(workflowsDir, "session-memory-sweep"), { recursive: true });
    await Bun.write(
      join(workflowsDir, "session-memory-sweep", "workflow.ts"),
      await Bun.file(join(import.meta.dir, "workflow.ts")).text(),
    );

    const registry = await buildRegistry({ workflowsDir });
    expect(registry.errors).toEqual([]);
    expect(
      evaluateTriggerEvent(registry, { kind: "lifecycle", event: "pre-compact" }).map(
        (spec) => spec.name,
      ),
    ).toEqual(["session-memory-sweep"]);
    expect(
      evaluateTriggerEvent(registry, { kind: "lifecycle", event: "stop" }).map((spec) => spec.name),
    ).toEqual(["session-memory-sweep"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
