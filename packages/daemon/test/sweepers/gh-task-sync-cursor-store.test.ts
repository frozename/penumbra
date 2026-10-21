import { loadSqliteVec, migrate, T0Writer, TaskWriter } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { GhClient } from "@src/services/gh-client.js";
import { createGhReconcileCursorStore } from "@src/sweepers/gh-task-sync-scope.js";
import { createDefaultGhTaskSyncService } from "@src/sweepers/gh-task-sync.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  void 0;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

describe("gh reconcile cursor store", () => {
  test("cursors are kept per repo in db_meta and survive a new store instance", () => {
    const db = freshDb();
    const store = createGhReconcileCursorStore(db);
    expect(store.get("frozename/penumbra")).toBeNull();

    store.set("frozename/penumbra", "2026-10-20T11:58:00Z");
    store.set("frozename/nova", "2026-10-19T00:00:00Z");
    store.set("frozename/penumbra", "2026-10-20T12:03:00Z");

    const restarted = createGhReconcileCursorStore(db);
    expect(restarted.get("frozename/penumbra")).toBe("2026-10-20T12:03:00Z");
    expect(restarted.get("frozename/nova")).toBe("2026-10-19T00:00:00Z");
  });

  test("the default service persists the cursor a scoped reconcile establishes", async () => {
    const db = freshDb();
    const now = Date.parse("2026-10-20T12:00:00.000Z");
    const writer = new TaskWriter(db, { now: (): number => now });
    const { task_id } = writer.file({
      prompt: "linked",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 5 });
    const ghClient = {
      viewIssue: () =>
        Promise.resolve({
          number: 5,
          state: "OPEN",
          stateReason: null,
          updatedAt: "2026-10-20T10:00:00Z",
          title: "Issue 5",
          url: "https://github.com/frozename/penumbra/issues/5",
        }),
      listComments: () => Promise.resolve([]),
      listIssuesUpdatedSince: () =>
        Promise.resolve({ serverTime: "2026-10-20T12:00:07.000Z", issues: [] }),
    } as unknown as GhClient;
    const service = createDefaultGhTaskSyncService(
      {
        db,
        t0Writer: new T0Writer(db),
        clock: () => new Date(now),
        uuid: () => crypto.randomUUID(),
        machineId: { get: () => "test" },
      },
      writer,
      ghClient,
    );

    await service.syncAllLinkedTasks({ changedOnly: true });

    expect(createGhReconcileCursorStore(db).get("frozename/penumbra")).toBe("2026-10-20T11:58:07Z");
  });
});
