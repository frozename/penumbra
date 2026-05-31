import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { migrate } from "../../src/db/migrations.js";
import { TestEmbedder } from "../../src/embedder/test-embedder.js";
import { RecallReader } from "../../src/readers/recall.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

async function seedT2Memory(opts: {
  memoryId: string;
  body: string;
  createdAt: string;
  why: string | null;
  sourceQuote: string | null;
  learnedAt: string | null;
  lastVerifiedAt: string | null;
}) {
  const embedder = new TestEmbedder({ dim: 384 });
  const [vec] = await embedder.embed([opts.body]);
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end,
      title, body, metadata_json, created_at, updated_at, why, source_quote, learned_at, last_verified_at
    )
    VALUES (?, 'p1', 'u', 'summary', '[]', ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)`,
    [
      opts.memoryId,
      opts.createdAt,
      opts.createdAt,
      `title-${opts.memoryId}`,
      opts.body,
      opts.createdAt,
      opts.createdAt,
      opts.why,
      opts.sourceQuote,
      opts.learnedAt,
      opts.lastVerifiedAt,
    ],
  );
  const rowid = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM t2_memories WHERE memory_id = ?")
    .get(opts.memoryId)!.rowid;
  db.run("INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)", [rowid, vec!]);
}

describe("RecallReader — t2 why/source_quote/learned_at/last_verified_at", () => {
  test("rrf path surfaces why/source_quote/learned_at/last_verified_at and remains null-safe", async () => {
    await seedT2Memory({
      memoryId: "t2-new-fields",
      body: "rrf marker with provenance",
      createdAt: "2026-05-30T10:00:00.000Z",
      why: "because the rollout fixed stale dispatch checks",
      sourceQuote: "stale-handoff-sweeper force-resolved with event-aware idle gate",
      learnedAt: "2026-05-30T10:05:00.000Z",
      lastVerifiedAt: "2026-05-30T10:06:00.000Z",
    });
    await seedT2Memory({
      memoryId: "t2-legacy-null",
      body: "rrf marker legacy row",
      createdAt: "2026-05-30T11:00:00.000Z",
      why: null,
      sourceQuote: null,
      learnedAt: null,
      lastVerifiedAt: null,
    });

    const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
    const results = await reader.recall({
      query: "rrf marker",
      project_id: "p1",
      limit: 10,
      include_raw: false,
      min_score: 0,
      sources: ["t2"],
    });

    const seeded = results.find((r) => r.id === "t2-new-fields");
    expect(seeded).toBeDefined();
    expect(seeded?.why).toBe("because the rollout fixed stale dispatch checks");
    expect(seeded?.source_quote).toBe(
      "stale-handoff-sweeper force-resolved with event-aware idle gate",
    );
    expect(seeded?.learned_at).toBe("2026-05-30T10:05:00.000Z");
    expect(seeded?.last_verified_at).toBe("2026-05-30T10:06:00.000Z");

    const legacy = results.find((r) => r.id === "t2-legacy-null");
    expect(legacy).toBeDefined();
    expect(legacy?.why ?? null).toBeNull();
    expect(legacy?.source_quote ?? null).toBeNull();
    expect(legacy?.learned_at ?? null).toBeNull();
    expect(legacy?.last_verified_at ?? null).toBeNull();
  });

  test("hybrid path surfaces why/source_quote/learned_at/last_verified_at and remains null-safe", async () => {
    await seedT2Memory({
      memoryId: "hybrid-new-fields",
      body: "hybrid marker with provenance",
      createdAt: "2026-05-30T12:00:00.000Z",
      why: "because hybrid rerank selected this note",
      sourceQuote: "vector rerank over metadata-filtered pool",
      learnedAt: "2026-05-30T12:03:00.000Z",
      lastVerifiedAt: "2026-05-30T12:04:00.000Z",
    });
    await seedT2Memory({
      memoryId: "hybrid-legacy-null",
      body: "hybrid marker legacy row",
      createdAt: "2026-05-30T12:30:00.000Z",
      why: null,
      sourceQuote: null,
      learnedAt: null,
      lastVerifiedAt: null,
    });

    const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
    const results = await reader.recall({
      query: "hybrid marker",
      project_id: "p1",
      limit: 10,
      include_raw: false,
      min_score: 0,
      strategy_hint: "hybrid",
    });

    const seeded = results.find((r) => r.id === "hybrid-new-fields");
    expect(seeded).toBeDefined();
    expect(seeded?.why).toBe("because hybrid rerank selected this note");
    expect(seeded?.source_quote).toBe("vector rerank over metadata-filtered pool");
    expect(seeded?.learned_at).toBe("2026-05-30T12:03:00.000Z");
    expect(seeded?.last_verified_at).toBe("2026-05-30T12:04:00.000Z");

    const legacy = results.find((r) => r.id === "hybrid-legacy-null");
    expect(legacy).toBeDefined();
    expect(legacy?.why ?? null).toBeNull();
    expect(legacy?.source_quote ?? null).toBeNull();
    expect(legacy?.learned_at ?? null).toBeNull();
    expect(legacy?.last_verified_at ?? null).toBeNull();
  });
});
