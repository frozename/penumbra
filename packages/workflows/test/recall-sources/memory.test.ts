import { loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runMemorySearchSource } from "@src/recall-sources/memory.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function insertMemory(
  db: Database,
  id: string,
  projectId: string | null,
  body: string,
  ts: string,
  userId = "u1",
  sessionIds: string[] = [id],
  origin: string | null = null,
): void {
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
    projectId,
    userId,
    "observation",
    JSON.stringify(sessionIds),
    ts,
    ts,
    body,
    body,
    "{}",
    ts,
    ts,
    "note",
    JSON.stringify([]),
    "low",
    origin,
  );
}

test("memory.search project filter matches rows with matching, NULL, or empty project_id (FTS path)", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, "m-match", "penumbra", "hello penumbra match", "2026-05-05T01:00:00Z");
  insertMemory(db, "m-null", null, "hello null project", "2026-05-05T02:00:00Z");
  insertMemory(db, "m-empty", "", "hello empty project", "2026-05-05T03:00:00Z");
  insertMemory(db, "m-other", "someone-else", "hello someone else", "2026-05-05T04:00:00Z");

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "hello", project: "penumbra", limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(["t2:m-empty", "t2:m-match", "t2:m-null"]);
});

test("memory.search project filter matches NULL/empty in non-FTS branch", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, "m-match", "penumbra", "fact a", "2026-05-05T01:00:00Z");
  insertMemory(db, "m-null", null, "fact b", "2026-05-05T02:00:00Z");
  insertMemory(db, "m-empty", "", "fact c", "2026-05-05T03:00:00Z");
  insertMemory(db, "m-other", "someone-else", "fact d", "2026-05-05T04:00:00Z");

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { project: "penumbra", dateStart: "2026-05-05T00:00:00Z", limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(["t2:m-empty", "t2:m-match", "t2:m-null"]);
});

test("memory.search returns hit list shape from real sqlite", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const embedder = new TestEmbedder({ dim: 384 });
  const t2Insert = db.prepare(`
    INSERT INTO t2_memories (
      memory_id, project_id, user_id, kind,
      source_session_ids, window_start, window_end,
      title, body, metadata_json, created_at, updated_at,
      obs_type, concepts, severity
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ts1 = "2026-05-04T10:00:00Z";
  const ts2 = "2026-05-04T11:00:00Z";
  t2Insert.run(
    "m1",
    "demo",
    "u1",
    "observation",
    JSON.stringify(["s1"]),
    ts1,
    ts1,
    "Fixed authentication bug",
    "Fixed authentication bug in JWT path",
    "{}",
    ts1,
    ts1,
    "bugfix",
    JSON.stringify(["auth"]),
    "medium",
  );
  t2Insert.run(
    "m2",
    "demo",
    "u1",
    "observation",
    JSON.stringify(["s2"]),
    ts2,
    ts2,
    "Added JWT verification",
    "Added JWT verification middleware",
    "{}",
    ts2,
    ts2,
    "feature",
    JSON.stringify(["auth"]),
    "low",
  );

  const out = await runMemorySearchSource({
    db,
    embedder,
    args: { query: "authentication", project: "demo", limit: 10 },
  });

  expect(out.hits.length).toBeGreaterThanOrEqual(1);
  const titles = out.hits.map((h) => h.title);
  expect(titles.some((t) => t.includes("authentication") || t.includes("JWT"))).toBe(true);
  expect(out.warnings).toEqual([]);
});

test("memory.search excludes metadata trust=untrusted by default and supports explicit opt-in", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.prepare(
    `
    INSERT INTO t2_memories (
      memory_id, project_id, user_id, kind,
      source_session_ids, window_start, window_end,
      title, body, metadata_json, created_at, updated_at,
      obs_type, concepts, severity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "m-safe",
    "demo",
    "u1",
    "observation",
    JSON.stringify(["s1"]),
    "2026-05-05T00:00:00Z",
    "2026-05-05T00:00:00Z",
    "safe",
    "safe body",
    "{}",
    "2026-05-05T00:00:00Z",
    "2026-05-05T00:00:00Z",
    "note",
    JSON.stringify([]),
    "low",
  );
  db.prepare(
    `
    INSERT INTO t2_memories (
      memory_id, project_id, user_id, kind,
      source_session_ids, window_start, window_end,
      title, body, metadata_json, created_at, updated_at,
      obs_type, concepts, severity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "m-untrusted",
    "demo",
    "u1",
    "observation",
    JSON.stringify(["s2"]),
    "2026-05-05T01:00:00Z",
    "2026-05-05T01:00:00Z",
    "unsafe",
    "unsafe body",
    '{"trust":"untrusted","source":"gh_comment"}',
    "2026-05-05T01:00:00Z",
    "2026-05-05T01:00:00Z",
    "note",
    JSON.stringify([]),
    "low",
  );

  const defaultOut = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { project: "demo", dateStart: "2026-05-05T00:00:00Z", limit: 10 },
  });
  expect(defaultOut.hits.map((h) => h.id)).toEqual(["t2:m-safe"]);

  const optedInOut = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: {
      project: "demo",
      dateStart: "2026-05-05T00:00:00Z",
      limit: 10,
      include_untrusted: true,
    },
  });
  expect(optedInOut.hits.map((h) => h.id).sort()).toEqual(["t2:m-safe", "t2:m-untrusted"]);
});

test("memory.search exclude_user_ids filters out matching user rows (FTS path)", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, "m-a1", "penumbra", "hello world A1", "2026-05-05T01:00:00Z", "A");
  insertMemory(db, "m-a2", "penumbra", "hello world A2", "2026-05-05T02:00:00Z", "A");
  insertMemory(db, "m-b1", "penumbra", "hello world B1", "2026-05-05T03:00:00Z", "B");

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "hello", exclude_user_ids: ["A"], limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(["t2:m-b1"]);
});

test("memory.search exclude_user_ids omitted or empty returns all rows", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, "m-a1", "penumbra", "hello world A1", "2026-05-05T01:00:00Z", "A");
  insertMemory(db, "m-a2", "penumbra", "hello world A2", "2026-05-05T02:00:00Z", "A");
  insertMemory(db, "m-b1", "penumbra", "hello world B1", "2026-05-05T03:00:00Z", "B");

  const outOmit = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "hello", limit: 10 },
  });
  expect(outOmit.hits.map((h) => h.id).sort()).toEqual(["t2:m-a1", "t2:m-a2", "t2:m-b1"]);

  const outEmpty = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "hello", exclude_user_ids: [], limit: 10 },
  });
  expect(outEmpty.hits.map((h) => h.id).sort()).toEqual(["t2:m-a1", "t2:m-a2", "t2:m-b1"]);
});

test("memory.search exclude_user_ids combines with project filter", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, "m-xa1", "X", "hello there A1", "2026-05-05T01:00:00Z", "A");
  insertMemory(db, "m-xa2", "X", "hello there A2", "2026-05-05T02:00:00Z", "A");
  insertMemory(db, "m-xb1", "X", "hello there B1", "2026-05-05T03:00:00Z", "B");
  insertMemory(db, "m-yb1", "Y", "hello there B2", "2026-05-05T04:00:00Z", "B");

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "hello", project: "X", exclude_user_ids: ["A"], limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(["t2:m-xb1"]);
});

test("memory.search exclude_user_ids works in date-only (non-FTS) branch", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, "m-a1", "penumbra", "fact A1", "2026-05-05T01:00:00Z", "A");
  insertMemory(db, "m-a2", "penumbra", "fact A2", "2026-05-05T02:00:00Z", "A");
  insertMemory(db, "m-b1", "penumbra", "fact B1", "2026-05-05T03:00:00Z", "B");

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { dateStart: "2026-05-05T00:00:00Z", exclude_user_ids: ["A"], limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(["t2:m-b1"]);
});

test("memory.search exclude_session_prefix filters rows whose source_session_ids start with prefix (FTS path)", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, "m-conv", "penumbra", "hello world conv", "2026-05-05T01:00:00Z", "u1", [
    "conv-aaa",
  ]);
  insertMemory(db, "m-sess", "penumbra", "hello world sess", "2026-05-05T02:00:00Z", "u1", [
    "sess-bbb",
  ]);
  insertMemory(db, "m-mixed", "penumbra", "hello world mixed", "2026-05-05T03:00:00Z", "u1", [
    "conv-ccc",
    "sess-ddd",
  ]);

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "hello", exclude_session_prefix: ["conv-"], limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(["t2:m-sess"]);
});

test("memory.search exclude_session_prefix omitted returns all rows", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, "m-conv", "penumbra", "hello world conv", "2026-05-05T01:00:00Z", "u1", [
    "conv-aaa",
  ]);
  insertMemory(db, "m-sess", "penumbra", "hello world sess", "2026-05-05T02:00:00Z", "u1", [
    "sess-bbb",
  ]);
  insertMemory(db, "m-mixed", "penumbra", "hello world mixed", "2026-05-05T03:00:00Z", "u1", [
    "conv-ccc",
    "sess-ddd",
  ]);

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "hello", limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(["t2:m-conv", "t2:m-mixed", "t2:m-sess"]);
});

test("memory.search exclude_session_prefix supports multiple prefixes", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, "m-conv", "penumbra", "hello world conv", "2026-05-05T01:00:00Z", "u1", [
    "conv-aaa",
  ]);
  insertMemory(db, "m-test", "penumbra", "hello world test", "2026-05-05T02:00:00Z", "u1", [
    "test-xxx",
  ]);
  insertMemory(db, "m-sess", "penumbra", "hello world sess", "2026-05-05T03:00:00Z", "u1", [
    "sess-bbb",
  ]);
  insertMemory(db, "m-prod", "penumbra", "hello world prod", "2026-05-05T04:00:00Z", "u1", [
    "prod-yyy",
  ]);

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "hello", exclude_session_prefix: ["conv-", "test-"], limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(["t2:m-prod", "t2:m-sess"]);
});

test("memory.search exclude_session_prefix works in date-only (non-FTS) branch", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, "m-conv", "penumbra", "fact conv", "2026-05-05T01:00:00Z", "u1", ["conv-aaa"]);
  insertMemory(db, "m-sess", "penumbra", "fact sess", "2026-05-05T02:00:00Z", "u1", ["sess-bbb"]);
  insertMemory(db, "m-mixed", "penumbra", "fact mixed", "2026-05-05T03:00:00Z", "u1", [
    "conv-ccc",
    "sess-ddd",
  ]);

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { dateStart: "2026-05-05T00:00:00Z", exclude_session_prefix: ["conv-"], limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(["t2:m-sess"]);
});

test("memory.search origin filter keeps maestro+unknown+NULL, excludes dispatch (FTS path)", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(
    db,
    "m-maestro",
    "penumbra",
    "hello maestro",
    "2026-05-05T01:00:00Z",
    "u1",
    ["s1"],
    "maestro",
  );
  insertMemory(
    db,
    "m-dispatch",
    "penumbra",
    "hello dispatch",
    "2026-05-05T02:00:00Z",
    "u1",
    ["s2"],
    "dispatch",
  );
  insertMemory(
    db,
    "m-unknown",
    "penumbra",
    "hello unknown",
    "2026-05-05T03:00:00Z",
    "u1",
    ["s3"],
    "unknown",
  );
  insertMemory(
    db,
    "m-legacy",
    "penumbra",
    "hello legacy",
    "2026-05-05T04:00:00Z",
    "u1",
    ["s4"],
    null,
  );

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "hello", origin: ["maestro", "unknown"], limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(["t2:m-legacy", "t2:m-maestro", "t2:m-unknown"]);
});

test("memory.search origin filter omitted returns all rows", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(
    db,
    "m-maestro",
    "penumbra",
    "hello maestro",
    "2026-05-05T01:00:00Z",
    "u1",
    ["s1"],
    "maestro",
  );
  insertMemory(
    db,
    "m-dispatch",
    "penumbra",
    "hello dispatch",
    "2026-05-05T02:00:00Z",
    "u1",
    ["s2"],
    "dispatch",
  );

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "hello", limit: 10 },
  });
  expect(out.hits.map((h) => h.id).sort()).toEqual(["t2:m-dispatch", "t2:m-maestro"]);
});

test("memory.search origin filter empty array returns all rows", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(
    db,
    "m-maestro",
    "penumbra",
    "hello maestro",
    "2026-05-05T01:00:00Z",
    "u1",
    ["s1"],
    "maestro",
  );
  insertMemory(
    db,
    "m-dispatch",
    "penumbra",
    "hello dispatch",
    "2026-05-05T02:00:00Z",
    "u1",
    ["s2"],
    "dispatch",
  );

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "hello", origin: [], limit: 10 },
  });
  expect(out.hits.map((h) => h.id).sort()).toEqual(["t2:m-dispatch", "t2:m-maestro"]);
});

test("memory.search origin filter works in date-only (non-FTS) branch", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(
    db,
    "m-maestro",
    "penumbra",
    "fact m",
    "2026-05-05T01:00:00Z",
    "u1",
    ["s1"],
    "maestro",
  );
  insertMemory(
    db,
    "m-dispatch",
    "penumbra",
    "fact d",
    "2026-05-05T02:00:00Z",
    "u1",
    ["s2"],
    "dispatch",
  );
  insertMemory(db, "m-legacy", "penumbra", "fact l", "2026-05-05T03:00:00Z", "u1", ["s3"], null);

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { dateStart: "2026-05-05T00:00:00Z", origin: ["maestro", "unknown"], limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(["t2:m-legacy", "t2:m-maestro"]);
});

test("memory.search origin filter combines with project filter", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(
    db,
    "m-x-maestro",
    "X",
    "hello there X-m",
    "2026-05-05T01:00:00Z",
    "u1",
    ["s1"],
    "maestro",
  );
  insertMemory(
    db,
    "m-x-dispatch",
    "X",
    "hello there X-d",
    "2026-05-05T02:00:00Z",
    "u1",
    ["s2"],
    "dispatch",
  );
  insertMemory(
    db,
    "m-y-maestro",
    "Y",
    "hello there Y-m",
    "2026-05-05T03:00:00Z",
    "u1",
    ["s3"],
    "maestro",
  );

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: "hello", project: "X", origin: ["maestro"], limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(["t2:m-x-maestro"]);
});
