import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  buildRegistry,
  evaluateTriggerEvent,
  type WorkflowCtx,
} from "../../../packages/workflows/src/index.js";
import { fn } from "./workflow.js";

const APPROVED_NOTE_READ_CAP_BYTES = 256 * 1024;

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

    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ts TEXT NOT NULL,
      ref_path TEXT,
      meta_json TEXT
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

function ordinaryCandidate(): Candidate {
  return {
    action: "create",
    slug: "ordinary-session-candidate",
    title: "Ordinary session candidate",
    body: "The extractor still contributes its ordinary derived candidate.",
    hook: "When ordinary extraction runs",
    why: "The approved note quote must not suppress the existing extraction output.",
    backlinks: ["ordinary"],
  };
}

function seedTranscript(db: Database): void {
  insertEvent(db, {
    id: "e1",
    sessionId: "session-1",
    eventType: "agent-prompt",
    summary:
      "Close-time session memory extraction should have enough transcript material to pass the sweep threshold. ".repeat(
        2,
      ),
  });
  insertEvent(db, {
    id: "e2",
    sessionId: "session-1",
    eventType: "agent-response",
    summary:
      "The workflow should render approval-only memory candidates after extracting session facts.",
  });
  insertEvent(db, {
    id: "e3",
    sessionId: "session-1",
    eventType: "agent-response",
    summary: "Approved session notes should be quoted verbatim when they exist for this session.",
  });
}

function insertDraftReviewedEvent(
  db: Database,
  row: {
    sessionId: string;
    refPath: string;
    ts?: string;
    outcome?: "approved" | "edited" | "rejected";
  },
): void {
  db.prepare(
    `INSERT INTO session_events (session_id, kind, ts, ref_path, meta_json)
     VALUES (?, 'continuity.draft_reviewed', ?, ?, ?)`,
  ).run(
    row.sessionId,
    row.ts ?? "2026-08-31T21:30:00.000Z",
    row.refPath,
    JSON.stringify({ outcome: row.outcome ?? "approved", draft_id: "draft-1" }),
  );
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

test("a t2 candidate offered after an approval quotes the approved note's narrative section verbatim, rather than re-deriving it", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-memory-sweep-note-"));
  try {
    const db = freshDb();
    seedTranscript(db);
    const notePath = join(root, "maestro-continuation-2026-08-31-pm.md");
    const narrativeSection = [
      "## Narrative and traps learned",
      "",
      "Distinctive approved narrative {alpha: 1, beta: [two]} stays byte-for-byte.",
      "Second line keeps punctuation: commas, semicolons; and braces {}.",
      "  Indented trap line keeps leading spaces.",
      "",
    ].join("\n");
    writeFileSync(
      notePath,
      [
        "<!-- penumbra:session session-1 -->",
        "",
        "## Live state",
        "",
        "Active.",
        "",
        narrativeSection,
        "## Open follow-ups (worst-first)",
        "",
        "- Follow up.",
      ].join("\n"),
    );
    insertDraftReviewedEvent(db, { sessionId: "session-1", refPath: notePath });
    const recall = { byKey: {}, warnings: [] };

    const result = await withEnv("PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS", "3", () =>
      fn(
        makeCtx(db, {
          extractSessionCandidates: async () => ({ candidates: [ordinaryCandidate()] }),
        }),
        recall,
      ),
    );

    expect(result).toContain(`Source: ${notePath} (approved 2026-08-31T21:30:00.000Z)`);
    expect(result).toContain(narrativeSection);
    expect(result).toContain("Ordinary session candidate");
    expect(result).toContain("The extractor still contributes its ordinary derived candidate.");
    expect(String(result).indexOf("Approved session note")).toBeLessThan(
      String(result).indexOf("Ordinary session candidate"),
    );
    expect(recall.warnings).toEqual([]);
    const t2Rows = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM t2_memories")
      .get();
    expect(t2Rows?.count).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an approved note larger than the read cap is not quoted and warns", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-memory-sweep-large-note-"));
  try {
    const db = freshDb();
    seedTranscript(db);
    const notePath = join(root, "maestro-continuation-large.md");
    const prefix = ["<!-- penumbra:session session-1 -->", "", "## Live state", ""].join("\n");
    const heading = "## Narrative and traps learned\n";
    const prefixBytes = Buffer.byteLength(prefix, "utf8");
    const headingBytes = Buffer.byteLength(heading, "utf8");
    const bytesBeforeHeading = APPROVED_NOTE_READ_CAP_BYTES - headingBytes - 64;
    const liveStatePadding = "x".repeat(bytesBeforeHeading - prefixBytes);
    writeFileSync(
      notePath,
      [
        prefix,
        liveStatePadding,
        heading,
        "This approved narrative begins before the cap.",
        "This line and the next content continue beyond the read cap. ".repeat(4096),
        "",
        "## Open follow-ups (worst-first)",
        "",
        "- Follow up.",
      ].join("\n"),
    );
    insertDraftReviewedEvent(db, { sessionId: "session-1", refPath: notePath });
    const recall = { byKey: {}, warnings: [] };

    const result = await withEnv("PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS", "3", () =>
      fn(
        makeCtx(db, {
          extractSessionCandidates: async () => ({ candidates: [ordinaryCandidate()] }),
        }),
        recall,
      ),
    );

    expect(result).toContain("Ordinary session candidate");
    expect(result).toContain("The extractor still contributes its ordinary derived candidate.");
    expect(result).not.toContain("Approved session note");
    expect(recall.warnings).toEqual([
      `session-memory-sweep: approved note quote skipped: ${notePath} exceeds ${APPROVED_NOTE_READ_CAP_BYTES} bytes`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without an approval the candidates are unchanged", async () => {
  const db = freshDb();
  seedTranscript(db);

  const result = await withEnv("PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS", "3", () =>
    fn(
      makeCtx(db, {
        extractSessionCandidates: async () => ({ candidates: [ordinaryCandidate()] }),
      }),
      { byKey: {}, warnings: [] },
    ),
  );

  expect(result).toBe(
    [
      "## Session memory candidates",
      "",
      "",
      "",
      "0. [create] Ordinary session candidate",
      "   - slug: ordinary-session-candidate",
      "   - hook: When ordinary extraction runs",
      "   - why: The approved note quote must not suppress the existing extraction output.",
      "   - backlinks: ordinary",
      "   - body:",
      "     The extractor still contributes its ordinary derived candidate.",
    ].join("\n"),
  );
});

test("an approved row whose note file is missing fails open with a warning", async () => {
  const db = freshDb();
  seedTranscript(db);
  const missingNotePath = join(tmpdir(), "missing-approved-session-note.md");
  insertDraftReviewedEvent(db, { sessionId: "session-1", refPath: missingNotePath });
  const recall = { byKey: {}, warnings: [] };

  const result = await withEnv("PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS", "3", () =>
    fn(
      makeCtx(db, {
        extractSessionCandidates: async () => ({ candidates: [ordinaryCandidate()] }),
      }),
      recall,
    ),
  );

  expect(result).toContain("Ordinary session candidate");
  expect(result).not.toContain("Approved session note");
  expect(recall.warnings).toEqual([
    expect.stringContaining("session-memory-sweep: approved session note unavailable"),
  ]);
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
