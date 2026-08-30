import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import { TestEmbedder } from "@src/testing/index.js";
import { type T2MemoryExtraction, T2MemoryExtractionSchema, T2Promotion } from "@src/writers/t2.js";

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
  migrate(db, { embeddingDim: 4 });
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

function seedT1(rollupId: string, sessionId: string): void {
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                             n_events, lane_breakdown_json, provider_breakdown_json, origin)
     VALUES (?, 'p1', 'u1', ?, '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z', 5, '{}', '{}', 'maestro')`,
    [rollupId, sessionId],
  );
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-prompt', 'local', '{}', ?)`,
    [`e-${sessionId}-1`, "2026-04-27T10:00:00Z", "2026-04-27T10:00:00Z", sessionId, "Prompt text"],
  );
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-response', 'local', '{}', ?)`,
    [
      `e-${sessionId}-2`,
      "2026-04-27T10:05:00Z",
      "2026-04-27T10:05:00Z",
      sessionId,
      "Response text",
    ],
  );
}

describe("T2 extraction schema + promote persistence for why/source_quote/learned_at", () => {
  test("schema accepts new extraction fields while legacy extraction remains valid", () => {
    const legacy = T2MemoryExtractionSchema.safeParse({
      title: "Legacy",
      body: "Legacy body",
      kind: "fact",
      metadata: { source: "legacy" },
    });
    expect(legacy.success).toBe(true);

    const enriched = T2MemoryExtractionSchema.safeParse({
      title: "Enriched",
      body: "Enriched body",
      kind: "fact",
      obs_type: "decision",
      why: "Captured a durable architectural decision",
      source_quote: "Use dispatch_land, not manual merge",
      learned_at: "2026-05-01T12:00:00.000Z",
      durability: "long",
      depth: 2,
      is_episodic: true,
    });

    expect(enriched.success).toBe(true);
    if (!enriched.success) return;
    expect(enriched.data.obs_type).toBe("decision");
    expect(enriched.data.why).toBe("Captured a durable architectural decision");
    expect(enriched.data.source_quote).toBe("Use dispatch_land, not manual merge");
    expect(enriched.data.learned_at).toBe("2026-05-01T12:00:00.000Z");
    expect(enriched.data.durability).toBe("long");
    expect(enriched.data.depth).toBe(2);
    expect(enriched.data.is_episodic).toBe(true);
  });

  test("promoteRollup persists new extraction fields and preserves NULL/default when omitted", async () => {
    seedT1("r-populated", "s-populated");
    seedT1("r-legacy", "s-legacy");

    const populated = new T2Promotion({
      db,
      embedder: new TestEmbedder({ dim: 4 }),
      clock: (): Date => new Date("2026-05-02T00:00:00.000Z"),
      uuid: (): string => "m-populated",
      minTranscriptChars: 0,
      llm: (): Promise<T2MemoryExtraction[]> =>
        Promise.resolve([
          {
            title: "Persist typed fields",
            body: "body",
            kind: "fact",
            obs_type: "feature",
            why: "Improves retrieval precision",
            source_quote: "T2.2 requires these fields",
            learned_at: "2026-05-01T10:00:00.000Z",
            durability: "medium",
            depth: 3,
            is_episodic: true,
          },
        ]),
    });

    const legacy = new T2Promotion({
      db,
      embedder: new TestEmbedder({ dim: 4 }),
      clock: (): Date => new Date("2026-05-02T00:00:00.000Z"),
      uuid: (): string => "m-legacy",
      minTranscriptChars: 0,
      llm: (): Promise<T2MemoryExtraction[]> =>
        Promise.resolve([
          {
            title: "Legacy extraction",
            body: "body",
            kind: "fact",
          },
        ]),
    });

    expect(await populated.promoteRollup("r-populated")).toBe(1);
    expect(await legacy.promoteRollup("r-legacy")).toBe(1);

    const populatedRow = db
      .query<
        {
          obs_type: string | null;
          why: string | null;
          source_quote: string | null;
          learned_at: string | null;
          durability: string | null;
          depth: number | null;
          is_episodic: number;
        },
        [string]
      >(
        `SELECT obs_type, why, source_quote, learned_at, durability, depth, is_episodic
         FROM t2_memories WHERE memory_id = ?`,
      )
      .get("m-populated");

    expect(populatedRow).toEqual({
      obs_type: "feature",
      why: "Improves retrieval precision",
      source_quote: "T2.2 requires these fields",
      learned_at: "2026-05-01T10:00:00.000Z",
      durability: "medium",
      depth: 3,
      is_episodic: 1,
    });

    const legacyRow = db
      .query<
        {
          obs_type: string | null;
          why: string | null;
          source_quote: string | null;
          learned_at: string | null;
          durability: string | null;
          depth: number | null;
          is_episodic: number;
        },
        [string]
      >(
        `SELECT obs_type, why, source_quote, learned_at, durability, depth, is_episodic
         FROM t2_memories WHERE memory_id = ?`,
      )
      .get("m-legacy");

    expect(legacyRow).toEqual({
      obs_type: null,
      why: null,
      source_quote: null,
      learned_at: null,
      durability: null,
      depth: null,
      is_episodic: 0,
    });
  });
});
