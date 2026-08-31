import { loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSessionEventsSource } from "../src/recall-sources/session-events.js";
import { composeRecall } from "../src/recall.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function insertMemory(
  db: Database,
  row: {
    memory_id: string;
    project_id: string;
    title: string;
    body: string;
    created_at: string;
    obs_type?: string;
  },
): void {
  const stmt = db.prepare(`
    INSERT INTO t2_memories (
      memory_id, project_id, user_id, kind,
      source_session_ids, window_start, window_end,
      title, body, metadata_json, created_at, updated_at,
      obs_type, concepts, severity
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    row.memory_id,
    row.project_id,
    "u1",
    "observation",
    JSON.stringify(["s1"]),
    row.created_at,
    row.created_at,
    row.title,
    row.body,
    "{}",
    row.created_at,
    row.created_at,
    row.obs_type ?? "note",
    JSON.stringify([]),
    "low",
  );
}

test("composes bundle from multiple sources, partial failures captured as warnings", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, {
    memory_id: "m1",
    project_id: "demo",
    title: "Fix bug",
    body: "Fixed a bug in login flow",
    created_at: "2026-05-04T10:00:00Z",
    obs_type: "bugfix",
  });

  db.run(`
    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES (1, 'h1', 'worker', 'dispatch.start', '2026-05-04T11:00:00Z', '{}');
  `);

  db.run(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES ('h1', '2026-05-04T11:00:00Z', 'c1', 'a', 'b', 'pending message', 'pending');
  `);

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: "/nonexistent-path-for-git-failure-test",
    project: "demo",
    sources: [
      { source: "memory_search", args: { query: "bug", project: "demo", limit: 10 } },
      { source: "dispatch_events", args: { since: "2026-05-04T10:00:00Z" } },
      { source: "handoff_list_pending" },
      { source: "git.log", args: { range: "HEAD" } },
    ],
    budgetTokens: 8000,
  });

  expect(bundle.byKey["memory_search"]).toBeDefined();
  expect(bundle.byKey["dispatch_events"]).toBeDefined();
  expect(bundle.byKey["handoff_list_pending"]).toBeDefined();
  expect(bundle.byKey["git.log"]).toBeDefined();
  expect(bundle.warnings.some((w) => w.includes("git.log"))).toBe(true);
});

test("composeRecall resolves a session_events source into byKey", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO session_events (session_id, kind, ts, meta_json)
    VALUES ('s-1', 'continuity.boot_pickup', '2026-05-04T11:00:00Z', '{"picked_up":true}');
  `);

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: process.cwd(),
    project: "demo",
    sources: [{ source: "session_events", args: { kind_prefix: "continuity." } }],
    budgetTokens: 8000,
  });

  expect(bundle.byKey["session_events"]).toEqual([
    expect.objectContaining({
      session_id: "s-1",
      kind: "continuity.boot_pickup",
      meta_json: '{"picked_up":true}',
    }),
  ]);
  expect(bundle.warnings).toEqual([]);
});

test("session_events recall source clamps absurd limits to 500 rows", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const insert = db.transaction((count: number) => {
    for (let i = 0; i < count; i += 1) {
      db.run(
        `INSERT INTO session_events (session_id, kind, ts, meta_json)
         VALUES ('s-1', 'session.start', ?, NULL)`,
        [`2026-05-04T11:${String(i).padStart(2, "0")}:00Z`],
      );
    }
  });
  insert(501);

  const output = runSessionEventsSource({ db, args: { limit: 1_000_000_000 } });
  expect(output.events).toHaveLength(500);
  expect(output.warnings).toEqual([]);
  db.close();
});

test("session_events recall source escapes kind_prefix wildcards", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(`
    INSERT INTO session_events (session_id, kind, ts, meta_json)
    VALUES
      ('s-1', '%literal', '2026-05-04T11:00:00Z', NULL),
      ('s-1', '_literal', '2026-05-04T11:01:00Z', NULL),
      ('s-1', 'continuity.boot_pickup', '2026-05-04T11:02:00Z', NULL),
      ('s-1', 'continuityXboot_pickup', '2026-05-04T11:03:00Z', NULL),
      ('s-1', 'session.start', '2026-05-04T11:04:00Z', NULL)
  `);

  expect(
    runSessionEventsSource({ db, args: { kind_prefix: "%" } }).events.map((e) => e.kind),
  ).toEqual(["%literal"]);
  expect(
    runSessionEventsSource({ db, args: { kind_prefix: "_" } }).events.map((e) => e.kind),
  ).toEqual(["_literal"]);
  expect(
    runSessionEventsSource({ db, args: { kind_prefix: "continuity." } }).events.map((e) => e.kind),
  ).toEqual(["continuity.boot_pickup"]);
  db.close();
});

test("budget trim drops oldest items first", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  for (let i = 0; i < 50; i++) {
    const day = String(i + 1).padStart(2, "0");
    const idx = String(i);
    insertMemory(db, {
      memory_id: `m${idx}`,
      project_id: "demo",
      title: `Memory ${idx}`,
      body: `Body of memory number ${idx} with some additional padding text to consume tokens`,
      created_at: `2026-03-${day}T10:00:00Z`,
    });
  }

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: process.cwd(),
    project: "demo",
    sources: [
      { source: "memory_search", args: { project: "demo", limit: 50, dateStart: "2026-03-01" } },
    ],
    budgetTokens: 200,
  });

  expect(bundle.estimatedTokens).toBeLessThanOrEqual(200);
  expect(bundle.warnings.some((w) => w.includes("budget"))).toBe(true);
});

test("budget trim preserves string sources before memory items", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  for (let i = 0; i < 60; i++) {
    const idx = String(i);
    const day = String((i % 9) + 1);
    insertMemory(db, {
      memory_id: `m${idx}`,
      project_id: "demo",
      title: `Memory ${idx}`,
      body: `Memory ${idx} body text`,
      created_at: `2026-05-0${day}T10:00:00Z`,
    });
  }

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: process.cwd(),
    project: "demo",
    sources: [
      { source: "git.log", args: { range: "HEAD~2..HEAD", format: "%s" } },
      { source: "memory_search", args: { project: "demo", limit: 60, dateStart: "2026-05-01" } },
    ],
    budgetTokens: 400,
  });

  expect(typeof bundle.byKey["git.log"]).toBe("string");
  expect((bundle.byKey["git.log"] as string).length).toBeGreaterThan(0);
  expect(bundle.warnings.some((w) => w.includes("budget exceeded"))).toBe(true);
});

test("composes file.contents source output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-file-contents-"));
  const file = join(dir, "README.md");
  writeFileSync(file, "recall body\n");
  const db = new Database(":memory:");
  try {
    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: dir,
      storageRoot: dir,
      project: "demo",
      sources: [{ source: "file.contents", args: { path: "README.md" } }],
    });

    expect(bundle.byKey["file.contents"]).toEqual({
      path: file,
      body: "recall body\n",
      truncated: false,
      byte_size: Buffer.byteLength("recall body\n"),
    });
    expect(bundle.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});
