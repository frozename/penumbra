import { loadSqliteVec, migrate, T0Writer, TaskWriter } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { tasksSyncGhNowRoute } from "@src/routes/tasks.js";
import type { GhClient } from "@src/services/gh-client.js";
import { createGhTaskSyncService, type GhTaskSyncService } from "@src/sweepers/gh-task-sync.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  void 0;
}

interface SyncRow {
  gh_state: string;
}
interface SyncBody {
  results: SyncRow[];
  pushed: number;
}

test("POST /tasks/sync-gh-now with task_id uses pushStatusNow and returns post-push gh_state", async () => {
  let pushedTaskId: string | null = null;
  let syncCalled = false;
  const service: Pick<
    GhTaskSyncService,
    "syncLinkedTask" | "pushStatusNow" | "syncAllLinkedTasks"
  > = {
    syncLinkedTask: (task_id: string) => {
      syncCalled = true;
      return Promise.resolve({
        task_id,
        repo: "frozename/penumbra",
        issue_number: 11,
        gh_state: "OPEN",
        action: "pulled",
        last_sync_ts: "2026-05-08T00:00:00.000Z",
      });
    },
    pushStatusNow: (task_id: string) => {
      pushedTaskId = task_id;
      return Promise.resolve({
        task_id,
        repo: "frozename/penumbra",
        issue_number: 11,
        gh_state: "CLOSED",
        action: "pushed",
        direction: "push",
        last_sync_ts: "2026-05-08T00:00:00.000Z",
      });
    },
    syncAllLinkedTasks: () => Promise.reject(new Error("unexpected")),
  };
  const res = await tasksSyncGhNowRoute(
    new Request("http://x/tasks/sync-gh-now", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "task-1" }),
    }),
    service as GhTaskSyncService,
  );

  expect(res.status).toBe(200);
  const body = (await res.json()) as SyncBody;
  expect(syncCalled).toBe(false);
  expect(pushedTaskId).toBe("task-1");
  expect(body.results[0].gh_state).toBe("CLOSED");
  expect(body.pushed).toBe(1);
});

test("POST /tasks/sync-gh-now without task_id reconciles every linked task, unscoped", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  const writer = new TaskWriter(db, { now: (): number => now });
  const { task_id } = writer.file({
    prompt: "long-cancelled task whose issue was reopened",
    created_by_kind: "human",
    created_by_id: "cli",
  });
  writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 41 });
  db.run(
    `UPDATE tasks SET status = 'cancelled', updated_at = ?, gh_comments_synced_at = ? WHERE id = ?`,
    [now - 30 * 86_400_000, now - 30 * 86_400_000 + 1_000, task_id],
  );
  const listed: string[] = [];
  const ghClient = {
    viewIssue: () =>
      Promise.resolve({
        number: 41,
        state: "OPEN",
        stateReason: null,
        updatedAt: "2026-10-20T11:00:00Z",
        title: "Issue 41",
        url: "https://github.com/frozename/penumbra/issues/41",
      }),
    listComments: () => Promise.resolve([]),
    listIssuesUpdatedSince: (repo: string) => {
      listed.push(repo);
      return Promise.resolve({ serverTime: "2026-10-20T12:00:00.000Z", issues: [] });
    },
  } as unknown as GhClient;
  const service = createGhTaskSyncService({
    taskWriter: writer,
    ghClient,
    t0Writer: new T0Writer(db),
    now: () => new Date(now),
    uuid: () => crypto.randomUUID(),
    reconcileCursors: { get: () => "2026-10-20T11:50:00Z", set: () => undefined },
  });

  const res = await tasksSyncGhNowRoute(
    new Request("http://x/tasks/sync-gh-now", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    service,
  );

  expect(res.status).toBe(200);
  const body = (await res.json()) as SyncBody & { linked: number };
  expect(body.linked).toBe(1);
  expect(listed).toEqual([]);
  expect(writer.get(task_id).status).toBe("pending");
});
