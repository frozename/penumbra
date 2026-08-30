import { loadSqliteVec, migrate } from "@src/index.js";
import { TestEmbedder } from "@src/testing/index.js";
import {
  type T2MemoryExtraction,
  T2Promotion,
  verifyMemory,
  writeDirectT2Memory,
} from "@src/writers/t2.js";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;
let previousExtractionFilterGate: string | undefined;
let previousNearDupGate: string | undefined;
beforeEach(() => {
  previousExtractionFilterGate = process.env.PENUMBRA_EXTRACTION_FILTER_GATE;
  previousNearDupGate = process.env.PENUMBRA_PROMOTION_NEAR_DUP_GATE;
  delete process.env.PENUMBRA_EXTRACTION_FILTER_GATE;
  delete process.env.PENUMBRA_PROMOTION_NEAR_DUP_GATE;
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

afterEach(() => {
  if (previousExtractionFilterGate === undefined) {
    delete process.env.PENUMBRA_EXTRACTION_FILTER_GATE;
  } else {
    process.env.PENUMBRA_EXTRACTION_FILTER_GATE = previousExtractionFilterGate;
  }
  if (previousNearDupGate === undefined) {
    delete process.env.PENUMBRA_PROMOTION_NEAR_DUP_GATE;
  } else {
    process.env.PENUMBRA_PROMOTION_NEAR_DUP_GATE = previousNearDupGate;
  }
});

function seedT1(
  rollupId: string,
  sessionId: string,
  endedAt: string,
  origin: string | null = null,
): void {
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                             n_events, lane_breakdown_json, provider_breakdown_json, origin)
     VALUES (?, 'p1', 'u1', ?, '2026-04-27T10:00:00Z', ?, 5, '{}', '{}', ?)`,
    [rollupId, sessionId, endedAt, origin],
  );
  // Add transcript events
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-prompt', 'local', '{}', ?)`,
    [
      `e-${sessionId}-1`,
      "2026-04-27T10:00:00Z",
      "2026-04-27T10:00:00Z",
      sessionId,
      "Tell me about the project",
    ],
  );
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-response', 'local', '{}', ?)`,
    [
      `e-${sessionId}-2`,
      "2026-04-27T10:05:00Z",
      "2026-04-27T10:05:00Z",
      sessionId,
      "The project is called Penumbra",
    ],
  );
}

function seedT1WithPayloadJsonOnly(
  rollupId: string,
  sessionId: string,
  endedAt: string,
  payloadPromptText: string,
  payloadResponseText: string,
): void {
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                             n_events, lane_breakdown_json, provider_breakdown_json)
     VALUES (?, 'p1', 'u1', ?, '2026-04-27T10:00:00Z', ?, 5, '{}', '{}')`,
    [rollupId, sessionId, endedAt],
  );
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-prompt', 'local', ?, NULL)`,
    [
      `e-${sessionId}-1`,
      "2026-04-27T10:00:00Z",
      "2026-04-27T10:00:00Z",
      sessionId,
      JSON.stringify({ text: payloadPromptText }),
    ],
  );
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-response', 'local', ?, NULL)`,
    [
      `e-${sessionId}-2`,
      "2026-04-27T10:05:00Z",
      "2026-04-27T10:05:00Z",
      sessionId,
      JSON.stringify({ text: payloadResponseText }),
    ],
  );
}

test("promoteRollup extracts memories and marks as promoted", async () => {
  seedT1("r1", "s1", "2026-04-27T10:05:00Z");

  const llm = (transcript: string): Promise<T2MemoryExtraction[]> => {
    expect(transcript).toContain("Tell me about the project");
    expect(transcript).toContain("Penumbra");
    return Promise.resolve([
      { title: "Project Name", body: "The project is called Penumbra", kind: "fact" },
    ]);
  };

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "m1",
    llm,
    minTranscriptChars: 0,
  });

  const count = await prom.promoteRollup("r1");
  expect(count).toBe(1);

  const memories = db.query<{ title: string }, []>("SELECT title FROM t2_memories").all();
  expect(memories.length).toBe(1);
  expect(memories[0].title).toBe("Project Name");

  const rollup = db
    .query<
      { t2_promoted_at: string | null },
      []
    >('SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id = "r1"')
    .get();
  expect(rollup?.t2_promoted_at).toBe("2026-04-27T15:00:00.000Z");
});

test("promoteRollup sends body-v1 embed text by default (inert-default)", async () => {
  seedT1("r-embed-default", "s-embed-default", "2026-04-27T10:05:00Z");
  const prev = process.env.PENUMBRA_T2_EMBED_RECIPE;
  delete process.env.PENUMBRA_T2_EMBED_RECIPE;
  const seen: string[][] = [];
  const embedder = {
    name: "spy",
    dim: 384,
    embed: (texts: string[]): Promise<Float32Array[]> => {
      seen.push(texts);
      return Promise.resolve(texts.map(() => new Float32Array(384)));
    },
  };

  try {
    const prom = new T2Promotion({
      db,
      embedder,
      clock: (): Date => new Date("2026-04-27T15:00:00Z"),
      uuid: (): string => "m-embed-default",
      llm: (): Promise<T2MemoryExtraction[]> =>
        Promise.resolve([{ title: "Project Name", body: "The body text", kind: "fact" }]),
      minTranscriptChars: 0,
    });

    const count = await prom.promoteRollup("r-embed-default");
    expect(count).toBe(1);
    expect(seen).toEqual([["The body text"]]);
  } finally {
    if (prev === undefined) delete process.env.PENUMBRA_T2_EMBED_RECIPE;
    else process.env.PENUMBRA_T2_EMBED_RECIPE = prev;
  }
});

test("promoteRollup routes embed input through title recipe when enabled", async () => {
  seedT1("r-embed-title", "s-embed-title", "2026-04-27T10:05:00Z");
  const prev = process.env.PENUMBRA_T2_EMBED_RECIPE;
  process.env.PENUMBRA_T2_EMBED_RECIPE = "title_only";
  const seen: string[][] = [];
  const embedder = {
    name: "spy",
    dim: 384,
    embed: (texts: string[]): Promise<Float32Array[]> => {
      seen.push(texts);
      return Promise.resolve(texts.map(() => new Float32Array(384)));
    },
  };

  try {
    const prom = new T2Promotion({
      db,
      embedder,
      clock: (): Date => new Date("2026-04-27T15:00:00Z"),
      uuid: (): string => "m-embed-title",
      llm: (): Promise<T2MemoryExtraction[]> =>
        Promise.resolve([{ title: "A title", body: "The body text", kind: "fact" }]),
      minTranscriptChars: 0,
    });

    const count = await prom.promoteRollup("r-embed-title");
    expect(count).toBe(1);
    expect(seen).toEqual([["A title"]]);
  } finally {
    if (prev === undefined) delete process.env.PENUMBRA_T2_EMBED_RECIPE;
    else process.env.PENUMBRA_T2_EMBED_RECIPE = prev;
  }
});

test("promoteRollup skips oversized extraction body without throwing", async () => {
  seedT1("r-oversized", "s-oversized", "2026-04-27T10:05:00Z");

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "m-oversized",
    llm: (): Promise<T2MemoryExtraction[]> =>
      Promise.resolve([{ title: "Too Long", body: "L".repeat(4097), kind: "fact" }]),
    minTranscriptChars: 0,
  });

  const count = await prom.promoteRollup("r-oversized");
  expect(count).toBe(0);
  const memories = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memories`).get();
  expect(memories?.c).toBe(0);
});

test("promoteRollup skips extraction body containing tool-call xml bleed markers", async () => {
  seedT1("r-xml", "s-xml", "2026-04-27T10:05:00Z");

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "m-xml",
    llm: (): Promise<T2MemoryExtraction[]> =>
      Promise.resolve([
        {
          title: "Bad XML",
          body: "Assistant emitted <tool_call id='1'>payload</tool_call> raw markup.",
          kind: "fact",
        },
      ]),
    minTranscriptChars: 0,
  });

  const count = await prom.promoteRollup("r-xml");
  expect(count).toBe(0);
  const memories = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memories`).get();
  expect(memories?.c).toBe(0);
});

test("promoteRollup continues promotion for valid extraction when another extraction is oversized", async () => {
  seedT1("r-mixed", "s-mixed", "2026-04-27T10:05:00Z");

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: ((): (() => string) => {
      const ids = ["m-mixed-good", "m-mixed-bad"];
      return (): string => ids.shift() ?? "m-mixed-fallback";
    })(),
    llm: (): Promise<T2MemoryExtraction[]> =>
      Promise.resolve([
        { title: "Bad oversized", body: "B".repeat(5000), kind: "fact" },
        { title: "Good", body: "This valid extraction should still promote.", kind: "fact" },
      ]),
    minTranscriptChars: 0,
  });

  const count = await prom.promoteRollup("r-mixed");
  expect(count).toBe(1);
  const rows = db
    .query<
      { title: string; body: string },
      []
    >(`SELECT title, body FROM t2_memories ORDER BY rowid ASC`)
    .all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({
    title: "Good",
    body: "This valid extraction should still promote.",
  });
});

test("promoteRollup logs skipped extraction count and reason", async () => {
  seedT1("r-skip-count", "s-skip-count", "2026-04-27T10:05:00Z");
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const prom = new T2Promotion({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      clock: (): Date => new Date("2026-04-27T15:00:00Z"),
      uuid: (): string => "m-skip-count",
      llm: (): Promise<T2MemoryExtraction[]> =>
        Promise.resolve([{ title: "Too Long", body: "Z".repeat(4097), kind: "fact" }]),
      minTranscriptChars: 0,
    });
    await prom.promoteRollup("r-skip-count");
  } finally {
    console.warn = originalWarn;
  }

  const combined = warnings.join("\n");
  expect(combined).toContain("reason=length");
  expect(combined).toContain("skipped=1");
  expect(combined).toContain("title=Too Long");
});

test("promoteRollup accepts normal 1500-char extraction bodies", async () => {
  seedT1("r-normal-1500", "s-normal-1500", "2026-04-27T10:05:00Z");

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "m-normal-1500",
    llm: (): Promise<T2MemoryExtraction[]> =>
      Promise.resolve([{ title: "Normal", body: "N".repeat(1500), kind: "fact" }]),
    minTranscriptChars: 0,
  });

  const count = await prom.promoteRollup("r-normal-1500");
  expect(count).toBe(1);
  const row = db
    .query<{ body: string }, [string]>(`SELECT body FROM t2_memories WHERE memory_id = ?`)
    .get("m-normal-1500");
  expect(row?.body.length).toBe(1500);
});

test("promoteRollup handles empty transcript gracefully", async () => {
  // Seed rollup but no events
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                             n_events, lane_breakdown_json, provider_breakdown_json)
     VALUES (?, 'p1', 'u1', ?, '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z', 5, '{}', '{}')`,
    ["r-empty", "s-empty"],
  );

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "u",
    llm: (): Promise<T2MemoryExtraction[]> =>
      Promise.resolve([{ title: "X", body: "Y", kind: "fact" }]),
  });

  const count = await prom.promoteRollup("r-empty");
  expect(count).toBe(0);

  const rollup = db
    .query<
      { t2_promoted_at: string | null },
      []
    >('SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id = "r-empty"')
    .get();
  expect(rollup?.t2_promoted_at).toBe("2026-04-27T15:00:00.000Z");
});

test("detectEligibleRollups finds rollups past delay", () => {
  seedT1("r-old", "s-old", "2026-04-26T10:00:00Z"); // 29 hours ago
  seedT1("r-new", "s-new", "2026-04-27T14:30:00Z"); // 30 mins ago

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "u",
    llm: (): Promise<T2MemoryExtraction[]> => Promise.resolve([]),
  });

  const eligible = prom.detectEligibleRollups(24, new Date("2026-04-27T15:00:00Z"));
  expect(eligible).toContain("r-old");
  expect(eligible).not.toContain("r-new");
});

test("promoteRollup inherits origin from t1_rollup onto t2_memory", async () => {
  seedT1("r-orig", "s-orig", "2026-04-27T10:05:00Z", "maestro");

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "m-orig",
    llm: (): Promise<T2MemoryExtraction[]> =>
      Promise.resolve([{ title: "T", body: "B", kind: "fact" }]),
    minTranscriptChars: 0,
  });

  await prom.promoteRollup("r-orig");
  const row = db
    .query<{ origin: string | null }, [string]>("SELECT origin FROM t2_memories WHERE memory_id=?")
    .get("m-orig")!;
  expect(row.origin).toBe("maestro");
});

test("promoteRollup carries NULL origin through to t2_memory (legacy rollup)", async () => {
  seedT1("r-legacy", "s-legacy", "2026-04-27T10:05:00Z", null);

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "m-legacy",
    llm: (): Promise<T2MemoryExtraction[]> =>
      Promise.resolve([{ title: "T", body: "B", kind: "fact" }]),
    minTranscriptChars: 0,
  });

  await prom.promoteRollup("r-legacy");
  const row = db
    .query<{ origin: string | null }, [string]>("SELECT origin FROM t2_memories WHERE memory_id=?")
    .get("m-legacy")!;
  expect(row.origin).toBeNull();
});

test("verifyMemory treats duplicate memory/session verification as idempotent", () => {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                             window_start, window_end, title, body, metadata_json,
                             compressed_from, created_at, updated_at)
     VALUES ('m-dup', NULL, 'u1', 'fact', '[]', '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z',
             'T', 'B', '{}', NULL, '2026-04-27T10:05:00Z', '2026-04-27T10:05:00Z')`,
  );

  const first = verifyMemory(db, "m-dup", {
    verifierActor: "auto-lane-close",
    claimedBy: "agent-1",
    reason: "lane closed passed: passed",
    sessionId: "h-dup",
    uuid: (): string => "evt-1",
  });
  const second = verifyMemory(db, "m-dup", {
    verifierActor: "auto-lane-close",
    claimedBy: "agent-1",
    reason: "lane closed passed: passed",
    sessionId: "h-dup",
    uuid: (): string => "evt-2",
  });

  expect(first?.written).toBe(true);
  expect(second?.written).toBe(false);
  const count = db
    .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memory_verification_events`)
    .get();
  expect(count?.c).toBe(1);
});

test("verifyMemory defaults basis fields to null when omitted", () => {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                             window_start, window_end, title, body, metadata_json,
                             compressed_from, created_at, updated_at)
     VALUES ('m-basis-default', NULL, 'u1', 'fact', '[]', '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z',
             'T', 'B', '{}', NULL, '2026-04-27T10:05:00Z', '2026-04-27T10:05:00Z')`,
  );

  verifyMemory(db, "m-basis-default", {
    verifierActor: "auto-lane-close",
    claimedBy: "agent-1",
    reason: "lane closed passed: passed",
    sessionId: "h-basis-default",
    uuid: (): string => "evt-basis-default",
  });

  const row = db
    .query<
      {
        basis: string | null;
        basis_type: string | null;
        basis_detail: string | null;
      },
      [string]
    >(
      `SELECT basis, basis_type, basis_detail FROM t2_memory_verification_events WHERE memory_id = ?`,
    )
    .get("m-basis-default");
  expect(row).toEqual({
    basis: null,
    basis_type: null,
    basis_detail: null,
  });
});

test("verifyMemory persists provided basis fields", () => {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                             window_start, window_end, title, body, metadata_json,
                             compressed_from, created_at, updated_at)
     VALUES ('m-basis-populated', NULL, 'u1', 'fact', '[]', '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z',
             'T', 'B', '{}', NULL, '2026-04-27T10:05:00Z', '2026-04-27T10:05:00Z')`,
  );

  verifyMemory(db, "m-basis-populated", {
    verifierActor: "auto-lane-close",
    claimedBy: "agent-1",
    reason: "lane closed passed: passed",
    sessionId: "h-basis-populated",
    basis: {
      type: "lane_close",
      detail: "passed",
      basis: "dispatch verdict",
    },
    uuid: (): string => "evt-basis-populated",
  });

  const row = db
    .query<
      {
        basis: string | null;
        basis_type: string | null;
        basis_detail: string | null;
      },
      [string]
    >(
      `SELECT basis, basis_type, basis_detail FROM t2_memory_verification_events WHERE memory_id = ?`,
    )
    .get("m-basis-populated");
  expect(row).toEqual({
    basis: "dispatch verdict",
    basis_type: "lane_close",
    basis_detail: "passed",
  });
});

test("verifyMemory persists authorizedByHandoff when provided", () => {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                             window_start, window_end, title, body, metadata_json,
                             compressed_from, created_at, updated_at)
     VALUES ('m-auth-handoff', NULL, 'u1', 'fact', '[]', '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z',
             'T', 'B', '{}', NULL, '2026-04-27T10:05:00Z', '2026-04-27T10:05:00Z')`,
  );

  verifyMemory(db, "m-auth-handoff", {
    verifierActor: "auto-lane-close",
    claimedBy: "agent-1",
    reason: "lane closed passed: passed",
    sessionId: "h-auth-handoff",
    authorizedByHandoff: "h-auth",
    uuid: (): string => "evt-auth-handoff",
  });

  const row = db
    .query<
      {
        authorized_by_handoff: string | null;
      },
      [string]
    >(`SELECT authorized_by_handoff FROM t2_memory_verification_events WHERE memory_id = ?`)
    .get("m-auth-handoff");
  expect(row).toEqual({
    authorized_by_handoff: "h-auth",
  });
});

test("detectEligibleRollups respects minEvents threshold", () => {
  seedT1("r-eligible", "s-eligible", "2026-04-26T10:00:00Z"); // n_events = 5
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                             n_events, lane_breakdown_json, provider_breakdown_json)
     VALUES (?, 'p1', 'u1', ?, '2026-04-26T10:00:00Z', '2026-04-26T10:05:00Z', 4, '{}', '{}')`,
    ["r-ineligible", "s-ineligible"],
  );

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "u",
    llm: (): Promise<T2MemoryExtraction[]> => Promise.resolve([]),
    minEvents: 5,
  });

  const eligible = prom.detectEligibleRollups(24, new Date("2026-04-27T15:00:00Z"));
  expect(eligible).toContain("r-eligible");
  expect(eligible).not.toContain("r-ineligible");
});

test("detectEligibleRollups excludes promotion-filtered rollups", () => {
  seedT1("r-skipped", "s-skipped", "2026-04-26T10:00:00Z");
  db.run(
    `UPDATE t1_rollups SET promotion_filtered_at = '2026-04-27T15:00:00.000Z' WHERE rollup_id = 'r-skipped'`,
  );

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "u",
    llm: (): Promise<T2MemoryExtraction[]> => Promise.resolve([]),
    minEvents: 5,
  });

  const eligible = prom.detectEligibleRollups(24, new Date("2026-04-27T15:00:00Z"));
  expect(eligible).not.toContain("r-skipped");
});

test("resetPromotionFilter requires an explicit all-rows reset", () => {
  seedT1("r-one", "s-one", "2026-04-26T10:00:00Z");
  seedT1("r-two", "s-two", "2026-04-26T10:00:00Z");
  db.run(
    `UPDATE t1_rollups SET promotion_filtered_at = '2026-04-27T15:00:00.000Z' WHERE rollup_id IN ('r-one', 'r-two')`,
  );

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "u",
    llm: (): Promise<T2MemoryExtraction[]> => Promise.resolve([]),
    minEvents: 5,
  });

  prom.resetPromotionFilter("r-one");
  let rows = db
    .prepare(
      `SELECT rollup_id, promotion_filtered_at FROM t1_rollups WHERE rollup_id IN ('r-one', 'r-two') ORDER BY rollup_id`,
    )
    .all() as { rollup_id: string; promotion_filtered_at: string | null }[];
  expect(rows).toEqual([
    { rollup_id: "r-one", promotion_filtered_at: null },
    { rollup_id: "r-two", promotion_filtered_at: "2026-04-27T15:00:00.000Z" },
  ]);

  expect(() => {
    prom.resetPromotionFilter("", undefined);
  }).toThrow("resetPromotionFilter requires a rollupId or { all: true }");
  rows = db
    .prepare(
      `SELECT rollup_id, promotion_filtered_at FROM t1_rollups WHERE rollup_id IN ('r-one', 'r-two') ORDER BY rollup_id`,
    )
    .all() as { rollup_id: string; promotion_filtered_at: string | null }[];
  expect(rows).toEqual([
    { rollup_id: "r-one", promotion_filtered_at: null },
    { rollup_id: "r-two", promotion_filtered_at: "2026-04-27T15:00:00.000Z" },
  ]);

  prom.resetPromotionFilter(null, { all: true });
  rows = db
    .prepare(
      `SELECT rollup_id, promotion_filtered_at FROM t1_rollups WHERE rollup_id IN ('r-one', 'r-two') ORDER BY rollup_id`,
    )
    .all() as { rollup_id: string; promotion_filtered_at: string | null }[];
  expect(rows).toEqual([
    { rollup_id: "r-one", promotion_filtered_at: null },
    { rollup_id: "r-two", promotion_filtered_at: null },
  ]);
});

test("promoteRollup replaces orphaned t2_vec rowids", async () => {
  seedT1("r-orphan", "s-orphan", "2026-04-27T10:05:00Z");
  db.run(`INSERT INTO t2_vec(rowid, embedding) VALUES (?, ?)`, [1, new Float32Array(384)]);

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "m-orphan",
    llm: (): Promise<T2MemoryExtraction[]> =>
      Promise.resolve([{ title: "T", body: "B", kind: "fact" }]),
    minTranscriptChars: 0,
  });

  const count = await prom.promoteRollup("r-orphan");
  expect(count).toBe(1);

  const memories = db.query<{ c: number }, []>("SELECT COUNT(*) c FROM t2_memories").get();
  expect(memories?.c).toBe(1);
  const vectors = db.query<{ c: number }, []>("SELECT COUNT(*) c FROM t2_vec").get();
  expect(vectors?.c).toBe(1);
});

test("promoteRollup deterministically keeps one promoted copy for identical high-frequency transcripts", async () => {
  seedT1("r-dedupe-1", "s-dedupe-1", "2026-04-27T10:05:00Z");
  seedT1("r-dedupe-2", "s-dedupe-2", "2026-04-27T10:05:00Z");

  const originalRandom = Math.random;
  Math.random = (): number => 0.1;
  try {
    const prom = new T2Promotion({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      clock: (): Date => new Date("2026-04-27T15:00:00Z"),
      uuid: ((): (() => string) => {
        const ids = ["m-dedupe-1", "m-dedupe-2"];
        return (): string => ids.shift() ?? "m-dedupe-fallback";
      })(),
      llm: (): Promise<T2MemoryExtraction[]> =>
        Promise.resolve([{ title: "Stable fact", body: "Stable body", kind: "fact" }]),
      minTranscriptChars: 0,
      highFrequencyThreshold: 0,
    });

    const first = await prom.promoteRollup("r-dedupe-1");
    const second = await prom.promoteRollup("r-dedupe-2");
    expect(first).toBe(1);
    expect(second).toBe(0);
  } finally {
    Math.random = originalRandom;
  }

  const memories = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memories`).get();
  expect(memories?.c).toBe(1);
});

test("promoteRollup uses payload_json transcript text and still applies transcript length gates", async () => {
  const shortPrompt = "tiny";
  const shortResponse = "small";
  seedT1WithPayloadJsonOnly(
    "r-json-short",
    "s-json-short",
    "2026-04-27T10:05:00Z",
    shortPrompt,
    shortResponse,
  );

  const shortInputs: string[] = [];
  const shortProm = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "m-json-short",
    llm: (transcript): Promise<T2MemoryExtraction[]> => {
      shortInputs.push(transcript);
      return Promise.resolve([{ title: "T", body: "B", kind: "fact" }]);
    },
    minTranscriptChars: 30,
    maxTranscriptChars: 200,
  });
  const shortCount = await shortProm.promoteRollup("r-json-short");
  expect(shortCount).toBe(0);
  expect(shortInputs).toHaveLength(0);

  const longPrompt = "P".repeat(120);
  const longResponse = "R".repeat(120);
  seedT1WithPayloadJsonOnly(
    "r-json-long",
    "s-json-long",
    "2026-04-27T10:05:00Z",
    longPrompt,
    longResponse,
  );

  const longInputs: string[] = [];
  const longProm = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "m-json-long",
    llm: (transcript): Promise<T2MemoryExtraction[]> => {
      longInputs.push(transcript);
      return Promise.resolve([{ title: "Long", body: "Body", kind: "fact" }]);
    },
    minTranscriptChars: 1,
    maxTranscriptChars: 40,
  });
  const longCount = await longProm.promoteRollup("r-json-long");
  expect(longCount).toBe(1);
  expect(longInputs).toHaveLength(1);
  expect(longInputs[0]).toContain("… [truncated] …");
});

test("promoteRollup strips tool-call xml tags from transcript content before LLM extraction", async () => {
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                             n_events, lane_breakdown_json, provider_breakdown_json)
     VALUES ('r-xml-transcript', 'p1', 'u1', 's-xml-transcript', '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z', 5, '{}', '{}')`,
  );
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES ('e-xml-transcript-1', '2026-04-27T10:00:00Z', '2026-04-27T10:00:00Z', 'mcp', 'u1', 'm1', 's-xml-transcript', 'agent-prompt', 'local', '{}', 'Please summarize tool behavior')`,
  );
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES ('e-xml-transcript-2', '2026-04-27T10:05:00Z', '2026-04-27T10:05:00Z', 'mcp', 'u1', 'm1', 's-xml-transcript', 'agent-response', 'local', '{}', ?)`,
    ["Completed <tool_call id='1'>fs_read()</tool_call> successfully."],
  );

  const seenTranscripts: string[] = [];
  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-27T15:00:00Z"),
    uuid: (): string => "m-xml-transcript",
    llm: (transcript): Promise<T2MemoryExtraction[]> => {
      seenTranscripts.push(transcript);
      return Promise.resolve([]);
    },
    minTranscriptChars: 0,
  });

  await prom.promoteRollup("r-xml-transcript");
  expect(seenTranscripts).toHaveLength(1);
  expect(seenTranscripts[0]).toContain("fs_read()");
  expect(seenTranscripts[0]).not.toContain("<tool_call");
  expect(seenTranscripts[0]).not.toContain("</tool_call>");
});

test("writeDirectT2Memory persists source_session_ids when provided", () => {
  const result = writeDirectT2Memory(db, {
    title: "Direct with session",
    body: "Body",
    embedding: new Float32Array(384),
    project_id: "p1",
    source_session_ids: ["sess-direct-1"],
  });

  const row = db
    .query<
      { source_session_ids: string },
      [string]
    >(`SELECT source_session_ids FROM t2_memories WHERE memory_id = ?`)
    .get(result.memory_id);
  expect(JSON.parse(row?.source_session_ids ?? "[]")).toEqual(["sess-direct-1"]);
});

test("writeDirectT2Memory persists why/source_quote/obs_type and sets learned_at", () => {
  const result = writeDirectT2Memory(db, {
    title: "Direct with fields",
    body: "Body",
    embedding: new Float32Array(384),
    why: "Why this memory matters",
    source_quote: "Body",
    obs_type: "operator_note",
  });

  const row = db
    .query<
      {
        why: string | null;
        source_quote: string | null;
        obs_type: string | null;
        learned_at: string | null;
        created_at: string;
      },
      [string]
    >(
      `SELECT why, source_quote, obs_type, learned_at, created_at FROM t2_memories WHERE memory_id = ?`,
    )
    .get(result.memory_id);
  expect(row).not.toBeNull();
  expect(row?.why).toBe("Why this memory matters");
  expect(row?.source_quote).toBe("Body");
  expect(row?.obs_type).toBe("operator_note");
  expect(row?.learned_at).toBe(row?.created_at);
});

test("writeDirectT2Memory rolls back t2_vec DELETE on slug-UPDATE when re-INSERT fails", () => {
  const original = new Float32Array(384);
  original[0] = 0.5;
  original[1] = -0.25;
  const first = writeDirectT2Memory(db, {
    title: "Slug embed survives",
    body: "Initial body",
    embedding: original,
    project_id: "p1",
    slug: "shared-slug",
  });

  const rowid = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM t2_memories WHERE memory_id = ?")
    .get(first.memory_id)!.rowid;

  const before = db
    .query<{ embedding: unknown }, [number]>("SELECT embedding FROM t2_vec WHERE rowid = ?")
    .get(rowid);
  expect(before).not.toBeNull();
  const beforeBytes = Buffer.from(before!.embedding as ArrayBuffer | Uint8Array as Uint8Array);

  const originalRun = db.run.bind(db);
  type DbRunArgs = Parameters<typeof db.run>;
  const failingRun: typeof db.run = (sql: string, ...rest: unknown[]) => {
    if (typeof sql === "string" && sql.startsWith("INSERT INTO t2_vec")) {
      throw new Error("forced t2_vec INSERT failure");
    }
    return originalRun(sql, ...(rest as DbRunArgs extends [string, ...infer R] ? R : never[]));
  };
  const dbInternals = db as unknown as { run: typeof db.run };
  dbInternals.run = failingRun;

  try {
    expect(() =>
      writeDirectT2Memory(db, {
        title: "Slug embed survives",
        body: "Replacement body",
        embedding: new Float32Array(384),
        project_id: "p1",
        slug: "shared-slug",
      }),
    ).toThrow();
  } finally {
    dbInternals.run = originalRun;
  }

  const after = db
    .query<{ embedding: unknown }, [number]>("SELECT embedding FROM t2_vec WHERE rowid = ?")
    .get(rowid);
  expect(after).not.toBeNull();
  const afterBytes = Buffer.from(after!.embedding as ArrayBuffer | Uint8Array as Uint8Array);
  expect(afterBytes.equals(beforeBytes)).toBe(true);

  const vecCount = db.query<{ c: number }, []>("SELECT COUNT(*) c FROM t2_vec").get();
  expect(vecCount?.c).toBe(1);

  const bodyRow = db
    .query<{ body: string }, [string]>("SELECT body FROM t2_memories WHERE memory_id = ?")
    .get(first.memory_id);
  expect(bodyRow?.body).toBe("Initial body");
});

test("writeDirectT2Memory persists durability/is_episodic and defaults omitted values", () => {
  const withMetadata = writeDirectT2Memory(db, {
    title: "Direct volatile status",
    body: "Body",
    embedding: new Float32Array(384),
    durability: "volatile",
    is_episodic: true,
  });
  const withoutMetadata = writeDirectT2Memory(db, {
    title: "Direct default metadata",
    body: "Body",
    embedding: new Float32Array(384),
  });

  const rows = db
    .query<
      {
        memory_id: string;
        durability: string | null;
        is_episodic: number;
      },
      [string, string]
    >(
      `SELECT memory_id, durability, is_episodic
       FROM t2_memories
       WHERE memory_id IN (?, ?)
       ORDER BY title ASC`,
    )
    .all(withoutMetadata.memory_id, withMetadata.memory_id);

  expect(rows).toEqual([
    {
      memory_id: withoutMetadata.memory_id,
      durability: null,
      is_episodic: 0,
    },
    {
      memory_id: withMetadata.memory_id,
      durability: "volatile",
      is_episodic: 1,
    },
  ]);
});
