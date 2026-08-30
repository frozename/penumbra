import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { EmitCapExceeded } from "@src/tasks/emit-caps.js";
import type { FileTaskInput } from "@src/tasks/schema.js";
import { TaskWriter } from "@src/tasks/writer.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function baseInput(overrides: Partial<FileTaskInput> = {}): FileTaskInput {
  return {
    prompt: "do the thing",
    created_by_kind: "agent",
    created_by_id: "agent-a",
    ...overrides,
  };
}

function expectEmitCap(
  fn: () => void,
  expected: { scope: "depth" | "descendants" | "rate"; limit: number; observed: number },
): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EmitCapExceeded);
    const cap = error as EmitCapExceeded;
    expect(cap.scope).toBe(expected.scope);
    expect(cap.limit).toBe(expected.limit);
    expect(cap.observed).toBe(expected.observed);
    return;
  }

  throw new Error("expected EmitCapExceeded");
}

describe("TaskWriter emit caps", () => {
  let db: Database;
  let writer: TaskWriter;

  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db);
  });

  test("descendants cap: 20 descendants succeed, 21st rejects with scope=descendants", () => {
    const root = writer.file(
      baseInput({ created_by_id: "agent-root", parent_task_id: undefined }),
    ).task_id;

    for (let i = 0; i < 20; i++) {
      writer.file(baseInput({ created_by_id: `agent-child-${String(i)}`, parent_task_id: root }));
    }

    expectEmitCap(
      () => writer.file(baseInput({ created_by_id: "agent-child-overflow", parent_task_id: root })),
      { scope: "descendants", limit: 20, observed: 20 },
    );
  });

  test("depth cap: depth 5 succeeds and depth 6 rejects with scope=depth", () => {
    const a = writer.file(baseInput()).task_id;
    const b = writer.file(baseInput({ parent_task_id: a })).task_id;
    const c = writer.file(baseInput({ parent_task_id: b })).task_id;
    const d = writer.file(baseInput({ parent_task_id: c })).task_id;
    const e = writer.file(baseInput({ parent_task_id: d })).task_id;
    const f = writer.file(baseInput({ parent_task_id: e })).task_id;

    expect(f).toMatch(/^task_[0-9a-f-]{36}$/);

    expectEmitCap(() => writer.file(baseInput({ parent_task_id: f })), {
      scope: "depth",
      limit: 5,
      observed: 6,
    });
  });

  test("rate cap: 10 in window allowed, 11th blocked until window elapses", () => {
    let now = 0;
    const timedWriter = new TaskWriter(db, () => now);

    for (let i = 0; i < 10; i++) {
      timedWriter.file(baseInput({ parent_task_id: undefined }));
    }

    now = 599_000;
    expect(() => timedWriter.file(baseInput({ parent_task_id: undefined }))).toThrow(
      EmitCapExceeded,
    );

    now = 600_001;
    expect(() => timedWriter.file(baseInput({ parent_task_id: undefined }))).not.toThrow();
  });

  test("human bypass: descendants, depth, and rate checks are skipped", () => {
    const human = (overrides: Partial<FileTaskInput> = {}): FileTaskInput => ({
      ...baseInput(overrides),
      created_by_kind: "human",
      created_by_id: "cli",
    });

    const root = writer.file(human()).task_id;

    for (let i = 0; i < 25; i++) {
      writer.file(human({ parent_task_id: root }));
    }

    let parent = root;
    for (let i = 0; i < 7; i++) {
      parent = writer.file(human({ parent_task_id: parent })).task_id;
    }

    for (let i = 0; i < 100; i++) {
      writer.file(human({ parent_task_id: undefined }));
    }
  });

  test("workflow bypass: descendants, depth, and rate checks are skipped", () => {
    const workflow = (overrides: Partial<FileTaskInput> = {}): FileTaskInput => ({
      ...baseInput(overrides),
      created_by_kind: "workflow",
      created_by_id: "workflow/task-board",
    });

    const root = writer.file(workflow()).task_id;

    for (let i = 0; i < 25; i++) {
      writer.file(workflow({ parent_task_id: root }));
    }

    let parent = root;
    for (let i = 0; i < 7; i++) {
      parent = writer.file(workflow({ parent_task_id: parent })).task_id;
    }

    for (let i = 0; i < 100; i++) {
      writer.file(workflow({ parent_task_id: undefined }));
    }
  });
});
