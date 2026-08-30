import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { TaskReader } from "@src/tasks/reader.js";
import { TaskNotFound, TaskWriter } from "@src/tasks/writer.js";

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

describe("TaskReader", () => {
  let db: Database;
  let writer: TaskWriter;
  let reader: TaskReader;

  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db);
    reader = new TaskReader(db);
  });

  test("get returns a task filed through TaskWriter", () => {
    const { task_id } = writer.file({
      prompt: "read me back",
      created_by_kind: "human",
      created_by_id: "cli",
    });

    const row = reader.get(task_id);
    expect(row.id).toBe(task_id);
    expect(row.prompt).toBe("read me back");
    expect(row.status).toBe("pending");
  });

  test("get throws TaskNotFound for an unknown id", () => {
    expect(() => reader.get("task_does-not-exist")).toThrow(TaskNotFound);
  });

  test("list surfaces filed tasks and honors status filters", () => {
    const a = writer.file({ prompt: "a", created_by_kind: "human", created_by_id: "cli" });
    const b = writer.file({ prompt: "b", created_by_kind: "human", created_by_id: "cli" });

    const pending = reader.list({ status: "pending" });
    expect(pending.map((t) => t.id).sort()).toEqual([a.task_id, b.task_id].sort());

    expect(reader.list({ status: "done" })).toEqual([]);
  });

  test("list with eligible_for returns [] when no resolveAgent dep is provided", () => {
    writer.file({ prompt: "a", created_by_kind: "human", created_by_id: "cli" });
    expect(reader.list({ eligible_for: "some-agent" })).toEqual([]);
  });

  test("exposes only read methods", () => {
    expect(Object.keys(reader).sort()).toEqual(["get", "list"]);
    expect((reader as unknown as Record<string, unknown>)["file"]).toBeUndefined();
    expect((reader as unknown as Record<string, unknown>)["lease"]).toBeUndefined();
  });
});
