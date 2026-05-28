import { expect, test } from "bun:test";
import { tasksSyncGhNowRoute } from "../../src/routes/tasks.js";

test("POST /tasks/sync-gh-now with task_id uses pushStatusNow and returns post-push gh_state", async () => {
  let pushedTaskId: string | null = null;
  let syncCalled = false;
  const res = await tasksSyncGhNowRoute(
    new Request("http://x/tasks/sync-gh-now", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "task-1" }),
    }),
    {
      syncLinkedTask: async () => {
        syncCalled = true;
        return {
          task_id: "task-1",
          repo: "acordeiro/penumbra",
          issue_number: 11,
          gh_state: "OPEN",
          action: "pulled",
          last_sync_ts: "2026-05-08T00:00:00.000Z",
        };
      },
      pushStatusNow: async (task_id: string) => {
        pushedTaskId = task_id;
        return {
          task_id,
          repo: "acordeiro/penumbra",
          issue_number: 11,
          gh_state: "CLOSED",
          action: "pushed",
          direction: "push",
          last_sync_ts: "2026-05-08T00:00:00.000Z",
        };
      },
      syncAllLinkedTasks: async () => {
        throw new Error("unexpected");
      },
    } as any,
  );

  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(syncCalled).toBe(false);
  expect(pushedTaskId).toBe("task-1");
  expect(body.results[0].gh_state).toBe("CLOSED");
  expect(body.pushed).toBe(1);
});
