import { loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowSpec } from "../src/schema.js";

import { executeWorkflow } from "../src/exec.js";
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

function makeContinuationNote(charCount: number, lastLine = "LAST_LINE_SENTINEL"): string {
  const first = "NOTE_START\n";
  const last = `\n${lastLine}\n`;
  return first + "n".repeat(Math.max(0, charCount - first.length - last.length)) + last;
}

function initRepoWithSubjects(subjects: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-git-log-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });

  for (const [index, subject] of subjects.entries()) {
    writeFileSync(join(dir, "tracked.txt"), `tracked ${String(index)}\n`);
    execSync("git add tracked.txt", { cwd: dir });
    execSync(`git commit -q -m ${JSON.stringify(subject)}`, { cwd: dir });
  }

  return dir;
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

test("composeRecall resolves routing_bias_list and registrar_status into byKey", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  db.run(
    `INSERT INTO routing_bias (bias_id, scope, value, mode, weight, reason, created_at, expires_at)
     VALUES ('b-1', 'agent', 'codex-fast', 'exclude', NULL, 'route around outage', '2026-05-04T10:00:00.000Z', '2099-05-04T18:00:00.000Z')`,
  );
  db.run(
    `INSERT INTO registrar_entries
       (registrar_id, slug, title, home_project, source_doc_path, status, created_at, updated_at)
     VALUES ('r-1', 'session-handoff-telemetry', 'Session handoff telemetry', 'penumbra', NULL, 'active', 100, 100)`,
  );

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: process.cwd(),
    project: "demo",
    sources: [{ source: "routing_bias_list" }, { source: "registrar_status" }],
    budgetTokens: 8000,
  });

  expect(bundle.byKey["routing_bias_list"]).toEqual([
    expect.objectContaining({ bias_id: "b-1", value: "codex-fast" }),
  ]);
  expect(bundle.byKey["registrar_status"]).toEqual([
    expect.objectContaining({ registrar_id: "r-1", slug: "session-handoff-telemetry" }),
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
  const dir = initRepoWithSubjects([
    "recall fixture first",
    "recall fixture second",
    "recall fixture third",
  ]);
  const db = new Database(":memory:");
  try {
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
      cwd: dir,
      project: "demo",
      sources: [
        { source: "git.log", args: { range: "HEAD~2..HEAD", format: "%s" } },
        {
          source: "memory_search",
          args: { project: "demo", limit: 60, dateStart: "2026-05-01" },
        },
      ],
      budgetTokens: 400,
    });

    expect(typeof bundle.byKey["git.log"]).toBe("string");
    expect(bundle.byKey["git.log"] as string).toContain("recall fixture third");
    expect(bundle.warnings.some((w) => w.includes("budget exceeded"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("tight budget drops small body-bearing array entries instead of inflating them with marker stubs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-small-git-show-"));
  const db = new Database(":memory:");
  try {
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "t@t"],
      ["config", "user.name", "t"],
    ]) {
      Bun.spawnSync({ cmd: ["git", ...args], cwd: dir });
    }

    for (let i = 0; i < 10; i += 1) {
      writeFileSync(join(dir, "tracked.txt"), `tracked ${String(i)}\n`);
      writeFileSync(join(dir, "commit-message.txt"), `subject ${String(i)}\n\nbody ${String(i)}\n`);
      Bun.spawnSync({ cmd: ["git", "add", "tracked.txt"], cwd: dir });
      Bun.spawnSync({ cmd: ["git", "commit", "-q", "-F", "commit-message.txt"], cwd: dir });
    }

    const budgetTokens = 235;
    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: dir,
      project: "demo",
      sources: [{ source: "git.show", args: { range: "HEAD", max_commits: 10 } }],
      budgetTokens,
    });

    const commits = bundle.byKey["git.show"] as { body: string }[];
    expect(bundle.estimatedTokens).toBeLessThanOrEqual(budgetTokens);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.length).toBeLessThan(10);
    expect(commits.every((commit) => !commit.body.includes("recall budget: body truncated"))).toBe(
      true,
    );
    expect(bundle.warnings.some((w) => w.includes("recall budget exceeded"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("budget trim drops other timestamp-less recalls before the continuation note", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-protected-note-"));
  const db = new Database(":memory:");
  try {
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    writeFileSync(join(dir, "tracked.txt"), "tracked\n");
    writeFileSync(join(dir, "commit-message.txt"), "subject\n\n" + "g".repeat(6_000));
    Bun.spawnSync({ cmd: ["git", "init", "-q", "-b", "main"], cwd: dir });
    Bun.spawnSync({ cmd: ["git", "config", "user.email", "t@t"], cwd: dir });
    Bun.spawnSync({ cmd: ["git", "config", "user.name", "t"], cwd: dir });
    Bun.spawnSync({ cmd: ["git", "add", "tracked.txt"], cwd: dir });
    Bun.spawnSync({ cmd: ["git", "commit", "-q", "-F", "commit-message.txt"], cwd: dir });
    mkdirSync(join(dir, "docs/notes"), { recursive: true });
    writeFileSync(
      join(dir, "docs/notes/maestro-continuation-2026-05-05.md"),
      makeContinuationNote(11_500),
    );
    writeFileSync(join(dir, "pending-handoff.md"), "PENDING_START\n" + "p".repeat(30_000));

    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: dir,
      repoRoot: dir,
      storageRoot: dir,
      project: "demo",
      sources: [
        { source: "git.log", args: { range: "HEAD", format: "%B" } },
        { source: "latest_continuation_note", args: { max_bytes: 65_536 } },
        { source: "session_first_moves", args: {} },
        {
          source: "file.contents",
          args: {
            path: "penumbra-storage:pending-handoff.md",
            max_bytes: 65_536,
            allowed_roots: ["penumbra-storage:"],
          },
        },
      ],
      budgetTokens: 4_000,
    });

    const note = bundle.byKey["latest_continuation_note"] as { body: string };
    const draft = bundle.byKey["file.contents"] as { body: string; truncated?: boolean } | null;
    expect(note.body).toContain("NOTE_START");
    expect(note.body.endsWith("LAST_LINE_SENTINEL\n")).toBe(true);
    expect(draft === null || draft.body === "" || draft.truncated === true).toBe(true);
    expect(bundle.estimatedTokens).toBeLessThanOrEqual(4_000);
    expect(bundle.warnings.some((w) => w.includes("recall budget exceeded"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("session_first_moves survives budget exhaustion intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-protected-first-moves-"));
  const db = new Database(":memory:");
  try {
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    writeFileSync(join(dir, "tracked.txt"), "tracked\n");
    Bun.spawnSync({ cmd: ["git", "init", "-q", "-b", "main"], cwd: dir });
    Bun.spawnSync({ cmd: ["git", "config", "user.email", "t@t"], cwd: dir });
    Bun.spawnSync({ cmd: ["git", "config", "user.name", "t"], cwd: dir });
    Bun.spawnSync({ cmd: ["git", "add", "tracked.txt"], cwd: dir });
    Bun.spawnSync({ cmd: ["git", "commit", "-q", "-m", "initial"], cwd: dir });
    mkdirSync(join(dir, "docs/notes"), { recursive: true });
    writeFileSync(
      join(dir, "docs/notes/maestro-continuation-2026-05-05.md"),
      makeContinuationNote(12_000),
    );

    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: dir,
      repoRoot: dir,
      project: "demo",
      sources: [
        { source: "latest_continuation_note", args: { max_bytes: 65_536 } },
        { source: "session_first_moves", args: {} },
      ],
      budgetTokens: 400,
    });

    const firstMoves = bundle.byKey["session_first_moves"] as {
      head_sha: string | null;
      origin_main_sha: string | null;
      daemon_healthy: boolean;
      worker_pids: number[];
      gate_deltas: { filtered: number | null; neardup: number | null };
    } | null;
    const note = bundle.byKey["latest_continuation_note"] as {
      body: string;
      truncated: boolean;
    };

    expect(firstMoves).not.toBeNull();
    if (firstMoves === null) throw new Error("session_first_moves was dropped");
    expect(firstMoves.head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(firstMoves.origin_main_sha).toBeNull();
    expect(typeof firstMoves.daemon_healthy).toBe("boolean");
    expect(Array.isArray(firstMoves.worker_pids)).toBe(true);
    expect(firstMoves.gate_deltas).toEqual({ filtered: 0, neardup: 0 });
    expect(note.body.startsWith("NOTE_START\n")).toBe(true);
    expect(note.body).toContain("… [recall budget: body truncated to ");
    expect(note.truncated).toBe(true);
    expect(
      bundle.warnings.some((w) => w.includes("protected session_first_moves kept intact")),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("a continuation note larger than the whole budget is head-truncated, never blanked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-truncated-note-"));
  const db = new Database(":memory:");
  try {
    mkdirSync(join(dir, "docs/notes"), { recursive: true });
    writeFileSync(
      join(dir, "docs/notes/maestro-continuation-2026-05-05.md"),
      makeContinuationNote(11_500),
    );

    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: dir,
      repoRoot: dir,
      project: "demo",
      sources: [{ source: "latest_continuation_note", args: { max_bytes: 65_536 } }],
      budgetTokens: 500,
    });

    const note = bundle.byKey["latest_continuation_note"] as {
      body: string;
      truncated: boolean;
    };
    expect(note.body.startsWith("NOTE_START\n")).toBe(true);
    expect(note.body).toContain("… [recall budget: body truncated to ");
    expect(note.truncated).toBe(true);
    expect(bundle.estimatedTokens).toBeLessThanOrEqual(500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("skip_if_arg drops a source only when the named arg resolves non-empty", async () => {
  const dir = initRepoWithSubjects(["skip one", "skip two"]);
  const db = new Database(":memory:");
  try {
    const source = {
      source: "git.log" as const,
      args: { range: "HEAD" },
      skip_if_arg: "content_path",
    };
    const templateCtxBase = {
      now: (): Date => new Date(),
      project: "demo",
      sessionStart: new Date().toISOString(),
      tz: "UTC",
      cwd: dir,
    };

    const skipped = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: dir,
      project: "demo",
      sources: [source],
      budgetTokens: 8000,
      templateCtx: { ...templateCtxBase, args: { content_path: "doc.md" } },
    });
    expect("git.log" in skipped.byKey).toBe(false);
    expect(skipped.warnings).toEqual([]);

    for (const args of [{}, { content_path: "" }]) {
      const ran = await composeRecall({
        db,
        embedder: new TestEmbedder({ dim: 384 }),
        cwd: dir,
        project: "demo",
        sources: [source],
        budgetTokens: 8000,
        templateCtx: { ...templateCtxBase, args },
      });
      expect(typeof ran.byKey["git.log"]).toBe("string");
      expect(ran.byKey["git.log"]).toContain("skip two");
    }

    // No templateCtx at all: the arg cannot resolve, so the source must run.
    const noCtx = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: dir,
      project: "demo",
      sources: [source],
      budgetTokens: 8000,
    });
    expect(typeof noCtx.byKey["git.log"]).toBe("string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
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

test("object-valued recall payloads are trimmed before rendering a session reminder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-object-budget-"));
  const db = new Database(":memory:");
  try {
    mkdirSync(join(dir, "docs/notes"), { recursive: true });
    const hugeBody = "NOTE_START\n" + "x".repeat(65_536);
    writeFileSync(join(dir, "docs/notes/maestro-continuation-2026-05-05.md"), hugeBody);

    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: dir,
      repoRoot: dir,
      project: "demo",
      sources: [{ source: "latest_continuation_note", args: { max_bytes: 65_536 } }],
      budgetTokens: 100,
    });
    const spec: WorkflowSpec = {
      name: "object-budget",
      description: "object budget test",
      triggers: [],
      recall: [{ source: "latest_continuation_note", args: { max_bytes: 65_536 } }],
      output: [{ kind: "session-reminder" }],
      run: { kind: "markdown-template", template: "{{recall.latest_continuation_note.body}}" },
    };

    const result = await executeWorkflow({ spec, bundle, storageRoot: dir });

    expect(bundle.estimatedTokens).toBeLessThanOrEqual(100);
    expect(bundle.warnings.some((w) => w.includes("recall budget exceeded"))).toBe(true);
    expect(result.sessionReminder ?? "").toContain("NOTE_START");
    expect(result.sessionReminder ?? "").toContain("… [recall budget: body truncated to ");
    expect(Buffer.byteLength(result.sessionReminder ?? "", "utf8")).toBeLessThanOrEqual(400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});
