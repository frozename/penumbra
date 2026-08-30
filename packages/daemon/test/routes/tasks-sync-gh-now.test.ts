import type { GhTaskSyncService } from "@src/sweepers/gh-task-sync.js";

import { tasksSyncGhNowRoute } from "@src/routes/tasks.js";
import { expect, test } from "bun:test";

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
