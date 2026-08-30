import { loadSqliteVec, migrate, T0Writer, TaskWriter } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { tasksCancelRoute } from "@src/routes/tasks.js";
import type { GhClient } from "@src/services/gh-client.js";
import { createGhTaskSyncService } from "@src/sweepers/gh-task-sync.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function createGhClientMock(commentBodies: string[]): GhClient {
  let viewCalls = 0;
  return {
    viewIssue(): Promise<{
      number: number;
      state: "OPEN" | "CLOSED";
      stateReason: null;
      updatedAt: string;
      title: string;
      url: string;
    }> {
      viewCalls += 1;
      return Promise.resolve({
        number: 91,
        state: viewCalls === 1 ? "OPEN" : "CLOSED",
        stateReason: null,
        updatedAt: "2026-05-08T18:00:00.000Z",
        title: "Issue 91",
        url: "https://github.com/frozename/penumbra/issues/91",
      });
    },
    closeIssue(): Promise<void> {
      return Promise.resolve();
    },
    reopenIssue(): Promise<void> {
      return Promise.resolve();
    },
    commentIssue(
      _repo: string,
      _issueNumber: number,
      body: string,
    ): Promise<{ comment_url: string }> {
      commentBodies.push(body);
      return Promise.resolve({
        comment_url: "https://github.com/frozename/penumbra/issues/91#issuecomment-777",
      });
    },
    listComments(): Promise<[]> {
      return Promise.resolve([]);
    },
  };
}

test("canceling a linked task posts a status_change comment to GitHub", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const writer = new TaskWriter(db, {
    now: (): number => Date.parse("2026-05-08T19:00:00.000Z"),
  });
  const { task_id } = writer.file({
    prompt: "cancel this task",
    created_by_kind: "human",
    created_by_id: "cli",
  });
  writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 91 });

  const commentBodies: string[] = [];
  const ghClient = createGhClientMock(commentBodies);

  const ghSync = createGhTaskSyncService({
    taskWriter: writer,
    ghClient,
    t0Writer: new T0Writer(db),
    now: () => new Date("2026-05-08T19:00:00.000Z"),
    uuid: () => crypto.randomUUID(),
  });

  const res = await tasksCancelRoute(
    new Request(`http://x/tasks/${task_id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "not needed" }),
    }),
    task_id,
    writer,
    ghSync,
  );

  expect(res.status).toBe(200);
  // Phase 4: GH side effects are queued to the outbox; drain it to assert delivery.
  await ghSync.syncAllLinkedTasks();
  expect(commentBodies).toHaveLength(1);
  expect(commentBodies[0]).toContain("kind=status_change");
});
