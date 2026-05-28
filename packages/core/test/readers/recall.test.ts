import { expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { migrate } from "../../src/db/migrations.js";
import { TestEmbedder } from "../../src/embedder/test-embedder.js";
import { RecallReader } from "../../src/readers/recall.js";

// On macOS, Bun uses the Apple SQLite build which disables extension loading.
// Switch to Homebrew's full-featured SQLite before any Database is created.
// See: https://bun.sh/docs/api/sqlite#loadextension
// Guard: setCustomSQLite throws if called after SQLite is already loaded (e.g.
// when multiple test files in the same bun test run each attempt the call).
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

async function seedT1(rollupId: string, text: string, createdAt: string) {
  const embedder = new TestEmbedder({ dim: 384 });
  const [vec] = await embedder.embed([text]);
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                            n_events, last_response_excerpt, first_prompt_excerpt)
     VALUES (?, ?, 'u', ?, ?, ?, 1, ?, ?)`,
    [rollupId, "p1", rollupId, createdAt, createdAt, text, text],
  );
  const rowid = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM t1_rollups WHERE rollup_id=?")
    .get(rollupId)!.rowid;
  db.run("INSERT INTO t1_vec(rowid, embedding) VALUES(?, ?)", [rowid, vec!]);
}

test("returns T1 rollups ranked by vector similarity", async () => {
  await seedT1("a", "the quick brown fox", "2026-04-20T00:00:00Z");
  await seedT1("b", "penguins march in the antarctic", "2026-04-21T00:00:00Z");

  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: "the quick brown fox",
    project_id: "p1",
    limit: 10,
    include_raw: false,
    min_score: 0,
  });
  expect(results[0]!.id).toBe("a");
  expect(results[0]!.tier).toBe("t1");
});

test("honors project_id filter", async () => {
  await seedT1("a", "x", "2026-04-20T00:00:00Z");
  db.run("UPDATE t1_rollups SET project_id='other' WHERE rollup_id='a'");
  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: "x",
    project_id: "p1",
    limit: 10,
    include_raw: false,
    min_score: 0,
  });
  expect(results.length).toBe(0);
});

test("empty DB returns empty array", async () => {
  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: "x",
    project_id: null,
    limit: 10,
    include_raw: false,
    min_score: 0,
  });
  expect(results).toEqual([]);
});

function seedT0(eventId: string, text: string, ts: string) {
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, payload_json, project_id)
     VALUES (?, ?, ?, 'mcp', 'u', 'm', 'request', 'local', ?, 'p1')`,
    [eventId, ts, ts, JSON.stringify({ text })],
  );
}

async function seedT2(memoryId: string, text: string, createdAt: string) {
  const embedder = new TestEmbedder({ dim: 384 });
  const [vec] = await embedder.embed([text]);
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, window_start, window_end,
                             title, body, created_at, updated_at)
     VALUES (?, 'p1', 'u', 'summary', ?, ?, 'title', ?, ?, ?)`,
    [memoryId, createdAt, createdAt, text, createdAt, createdAt],
  );
  const rowid = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM t2_memories WHERE memory_id=?")
    .get(memoryId)!.rowid;
  db.run("INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)", [rowid, vec!]);
}

test("returns T0 hits using FTS5 when include_raw is true", async () => {
  seedT0("evt1", "the quick brown fox", "2026-04-20T00:00:00Z");
  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: "fox",
    project_id: "p1",
    limit: 10,
    include_raw: true,
    min_score: 0,
  });
  expect(results.length).toBe(1);
  expect(results[0]!.id).toBe("evt1");
  expect(results[0]!.tier).toBe("t0");
  expect(results[0]!.sources).toEqual(["t0"]);
});

test("fuses multiple tiers and ranks items appearing in multiple tiers higher", async () => {
  // Insert identical strong match in T1 and T2
  await seedT1("t1_a", "common text", "2026-04-20T00:00:00Z");
  await seedT2("t2_a", "common text", "2026-04-20T00:00:00Z");

  // Insert an item only in T2
  await seedT2("t2_b", "common text", "2026-04-21T00:00:00Z");

  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: "common text",
    project_id: "p1",
    limit: 10,
    include_raw: false,
    min_score: 0,
  });

  // Because t2_a and t1_a both match well, but they are separate IDs, wait...
  // In the real system, a rollup might have the same ID as something else?
  // No, IDs are unique across tiers, but let's test if an ID is identical across tiers.
  // Actually, ID is the primary key in each tier table. A T1 and T2 probably have different IDs unless forced.
  // Let's manually force the same ID to test RRF deduplication/fusion.
  await seedT1("shared_id", "magic words", "2026-04-20T00:00:00Z");
  await seedT2("shared_id", "magic words", "2026-04-20T00:00:00Z");
  seedT0("shared_id", "magic words", "2026-04-20T00:00:00Z");

  // And a single-tier hit
  await seedT1("single_id", "magic words", "2026-04-20T00:00:00Z");

  const resultsFused = await reader.recall({
    query: "magic words",
    project_id: "p1",
    limit: 10,
    include_raw: true,
    min_score: 0,
  });

  const shared = resultsFused.find((r) => r.id === "shared_id");
  const single = resultsFused.find((r) => r.id === "single_id");

  expect(shared).toBeDefined();
  expect(single).toBeDefined();
  expect(shared!.fusedScore).toBeGreaterThan(single!.fusedScore);
  expect(shared!.sources).toEqual(["t0", "t1", "t2"]);
  expect(single!.sources).toEqual(["t1"]);
});

test("sources filter overrides include_raw", async () => {
  seedT0("evt1", "hello world", "2026-04-20T00:00:00Z");
  await seedT1("t1", "hello world", "2026-04-20T00:00:00Z");

  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: "hello world",
    project_id: "p1",
    limit: 10,
    include_raw: true,
    min_score: 0,
    sources: ["t0"],
  });

  expect(results.length).toBe(1);
  expect(results[0]!.id).toBe("evt1");
  expect(results[0]!.tier).toBe("t0");
});

test("excludes retired t2 memories from results", async () => {
  await seedT2("active", "unique phrase alpha", "2026-04-20T00:00:00Z");
  await seedT2("retired", "unique phrase alpha", "2026-04-21T00:00:00Z");
  db.run("UPDATE t2_memories SET retired_at = ? WHERE memory_id = 'retired'", [Date.now()]);

  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: "unique phrase alpha",
    project_id: "p1",
    limit: 10,
    include_raw: false,
    min_score: 0,
    sources: ["t2"],
  });
  expect(results.map((r) => r.id)).toEqual(["active"]);
});
