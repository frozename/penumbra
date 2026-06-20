import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

import { loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { runMemorySearchSource } from "../src/recall-sources/memory.js";

function setupT1Tables(db: Database) {
  // Real schema comes from migrate(); this helper exists only to keep the test
  // fixture name stable while relying on t1_rollups/t1_fts.
  void db;
}

function insertT2Memory(db: Database, id: string, ts: string, body: string) {
  db.prepare(
    `
    INSERT INTO t2_memories (
      memory_id, project_id, user_id, kind,
      source_session_ids, window_start, window_end,
      title, body, metadata_json, created_at, updated_at,
      obs_type, concepts, severity, origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    "demo",
    "u1",
    "observation",
    JSON.stringify([id]),
    ts,
    ts,
    body,
    body,
    "{}",
    ts,
    ts,
    "session",
    JSON.stringify(["x"]),
    "low",
    "dispatch",
  );
}

function insertT1Memory(db: Database, id: string, ts: string, body: string) {
  db.prepare(
    `
    INSERT INTO t1_rollups (
      rollup_id, project_id, user_id, session_id,
      started_at, ended_at, n_events,
      first_prompt_excerpt, last_response_excerpt, tool_calls_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(id, "demo", "u1", `s-${id}`, ts, ts, 1, body, body, body);
}

function freshDb() {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  setupT1Tables(db);
  return db;
}

test("memory.search tiers=t1+t2 returns both tiers", async () => {
  const db = freshDb();
  const ts = "2026-05-05T10:00:00Z";
  insertT1Memory(db, "m1", ts, "x from t1");
  insertT2Memory(db, "m2", ts, "x from t2");

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "x", dateStart: "2026-05-05T00:00:00Z", tiers: ["t1", "t2"], limit: 10 },
  });

  expect(out.hits.map((h) => h.id).sort()).toEqual(["t1:m1", "t2:m2"]);
});

test("memory.search tiers=t2 returns only t2 rows", async () => {
  const db = freshDb();
  const ts = "2026-05-05T10:00:00Z";
  insertT1Memory(db, "m1", ts, "x from t1");
  insertT2Memory(db, "m2", ts, "x from t2");

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "x", dateStart: "2026-05-05T00:00:00Z", tiers: ["t2"], limit: 10 },
  });

  expect(out.hits.map((h) => h.id)).toEqual(["t2:m2"]);
});

test("memory.search without tiers returns only t2 rows", async () => {
  const db = freshDb();
  const ts = "2026-05-05T10:00:00Z";
  insertT1Memory(db, "m1", ts, "x from t1");
  insertT2Memory(db, "m2", ts, "x from t2");

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "x", dateStart: "2026-05-05T00:00:00Z", limit: 10 },
  });

  expect(out.hits.map((h) => h.id)).toEqual(["t2:m2"]);
});

test("memory.search tiers=t1 returns only t1 rows", async () => {
  const db = freshDb();
  const ts = "2026-05-05T10:00:00Z";
  insertT1Memory(db, "m1", ts, "x from t1");
  insertT2Memory(db, "m2", ts, "x from t2");

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "x", dateStart: "2026-05-05T00:00:00Z", tiers: ["t1"], limit: 10 },
  });

  expect(out.hits.map((h) => h.id)).toEqual(["t1:m1"]);
});

test("memory.search tiers=t1 still returns hits when obs_type filter is supplied", async () => {
  // Regression: a previous in-place column substitution mapped `t.obs_type`
  // into `1=1` on the t1 branch, producing the broken WHERE fragment
  // `1=1 = ?` and silently zeroing all t1 hits whenever obs_type was set.
  const db = freshDb();
  const ts = "2026-05-05T10:00:00Z";
  insertT1Memory(db, "r1", ts, "rollout summary");
  insertT2Memory(db, "m1", ts, "rollout note");

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: {
      query: "rollout",
      dateStart: "2026-05-05T00:00:00Z",
      obs_type: "session",
      tiers: ["t1", "t2"],
      limit: 10,
    },
  });

  const ids = out.hits.map((h) => h.id).sort();
  // t1 has no obs_type column, so the filter must not exclude t1 rows; t2
  // rows must still honor the filter and only "session" rows survive.
  expect(ids).toContain("t1:r1");
  expect(ids).toContain("t2:m1");
  expect(out.warnings).toEqual([]);
});

test("memory.search tiers=t1 returns hits when obs_type filter would otherwise exclude them", async () => {
  // Even with an obs_type that no t2 row matches, t1 hits must still come back.
  const db = freshDb();
  const ts = "2026-05-05T10:00:00Z";
  insertT1Memory(db, "r1", ts, "rollout summary");

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: {
      query: "rollout",
      dateStart: "2026-05-05T00:00:00Z",
      obs_type: "bugfix",
      tiers: ["t1"],
      limit: 10,
    },
  });

  expect(out.hits.map((h) => h.id)).toEqual(["t1:r1"]);
  expect(out.warnings).toEqual([]);
});

test("memory.search tiers=t1 uses the real t1_rollups schema", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.prepare(
    `
    INSERT INTO t1_rollups (
      rollup_id, project_id, user_id, session_id,
      started_at, ended_at, n_events,
      first_prompt_excerpt, last_response_excerpt, tool_calls_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "r1",
    "demo",
    "u1",
    "s-r1",
    "2026-05-05T10:00:00Z",
    "2026-05-05T10:05:00Z",
    2,
    "ask about rollout",
    "done",
    "ask about rollout",
  );

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "rollout", dateStart: "2026-05-05T00:00:00Z", tiers: ["t1"], limit: 10 },
  });

  expect(out.hits.map((h) => h.id)).toEqual(["t1:r1"]);
});
