import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, migrate, TaskWriter, T0Writer } from "@penumbra/core";
import type { GhClient } from "../../src/services/gh-client.js";
import {
  createGhTaskSyncService,
  createGhTaskSyncSweeper,
} from "../../src/sweepers/gh-task-sync.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

function setup(): { db: Database; writer: TaskWriter; setNow: (ms: number) => void } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let nowMs = Date.parse("2026-05-08T00:00:00.000Z");
  const writer = new TaskWriter(db, { now: () => nowMs });
  return {
    db,
    writer,
    setNow: (ms) => {
      nowMs = ms;
    },
  };
}

describe("gh-task-sync sweeper/service", () => {
  test("linked pending task + GH closed pulls to cancelled and writes t0 event", async () => {
    const { db, writer, setNow } = setup();
    const { task_id } = writer.file({
      prompt: "sync me",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 10 });

    const ghClient: GhClient = {
      createIssue: async () => {
        throw new Error("not used");
      },
      viewIssue: async () => ({
        number: 10,
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        updatedAt: "2026-05-08T01:00:00.000Z",
        title: "Issue 10",
        url: "https://github.com/acordeiro/penumbra/issues/10",
      }),
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/10#issuecomment-1",
      }),
      listComments: async () => [],
    };

    setNow(Date.parse("2026-05-08T01:30:00.000Z"));
    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T01:30:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });
    const out = await sync.syncLinkedTask(task_id);

    expect(out.action).toBe("pulled");
    expect(writer.get(task_id).status).toBe("cancelled");

    const event = db
      .query<{ event_type: string; payload_json: string }, []>(
        `SELECT event_type, payload_json
         FROM t0_events
         WHERE event_type = 'task.gh_state_pulled'
         ORDER BY ts DESC
         LIMIT 1`,
      )
      .get();
    expect(event?.event_type).toBe("task.gh_state_pulled");
    expect(JSON.parse(event?.payload_json ?? "{}").task_id).toBe(task_id);
  });

  test("GH CLOSED+COMPLETED pulls to done", async () => {
    const { db, writer, setNow } = setup();
    const { task_id } = writer.file({
      prompt: "completed issue",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 12 });

    const ghClient: GhClient = {
      createIssue: async () => {
        throw new Error("not used");
      },
      viewIssue: async () => ({
        number: 12,
        state: "CLOSED",
        stateReason: "COMPLETED",
        updatedAt: "2026-05-08T01:00:00.000Z",
        title: "Issue 12",
        url: "https://github.com/acordeiro/penumbra/issues/12",
      }),
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/12#issuecomment-1",
      }),
      listComments: async () => [],
    };

    setNow(Date.parse("2026-05-08T01:30:00.000Z"));
    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T01:30:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });
    const out = await sync.syncLinkedTask(task_id);

    expect(out.action).toBe("pulled");
    expect(writer.get(task_id).status).toBe("done");
  });

  test("GH CLOSED+NOT_PLANNED pulls to cancelled", async () => {
    const { db, writer, setNow } = setup();
    const { task_id } = writer.file({
      prompt: "not planned issue",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 13 });

    const ghClient: GhClient = {
      createIssue: async () => {
        throw new Error("not used");
      },
      viewIssue: async () => ({
        number: 13,
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        updatedAt: "2026-05-08T01:00:00.000Z",
        title: "Issue 13",
        url: "https://github.com/acordeiro/penumbra/issues/13",
      }),
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/13#issuecomment-1",
      }),
      listComments: async () => [],
    };

    setNow(Date.parse("2026-05-08T01:30:00.000Z"));
    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T01:30:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });
    const out = await sync.syncLinkedTask(task_id);

    expect(out.action).toBe("pulled");
    expect(writer.get(task_id).status).toBe("cancelled");
  });

  test("GH CLOSED+null stateReason pulls to cancelled (safe default)", async () => {
    const { db, writer, setNow } = setup();
    const { task_id } = writer.file({
      prompt: "unknown close reason",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 14 });

    const ghClient: GhClient = {
      createIssue: async () => {
        throw new Error("not used");
      },
      viewIssue: async () => ({
        number: 14,
        state: "CLOSED",
        stateReason: null,
        updatedAt: "2026-05-08T01:00:00.000Z",
        title: "Issue 14",
        url: "https://github.com/acordeiro/penumbra/issues/14",
      }),
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/14#issuecomment-1",
      }),
      listComments: async () => [],
    };

    setNow(Date.parse("2026-05-08T01:30:00.000Z"));
    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T01:30:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });
    const out = await sync.syncLinkedTask(task_id);

    expect(out.action).toBe("pulled");
    expect(writer.get(task_id).status).toBe("cancelled");
  });

  test("linked done task newer than GH open pushes closeIssue(reason=completed)", async () => {
    const { db, writer, setNow } = setup();
    const { task_id } = writer.file({
      prompt: "done task",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 11 });

    setNow(Date.parse("2026-05-08T02:00:00.000Z"));
    db.run(`UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`, [
      Date.parse("2026-05-08T02:00:00.000Z"),
      task_id,
    ]);

    const closedCalls: Array<{ repo: string; issue: number; reason: "completed" | "not planned" }> =
      [];
    const ghClient: GhClient = {
      createIssue: async () => {
        throw new Error("not used");
      },
      viewIssue: async () => ({
        number: 11,
        state: "OPEN",
        stateReason: null,
        updatedAt: "2026-05-08T00:30:00.000Z",
        title: "Issue 11",
        url: "https://github.com/acordeiro/penumbra/issues/11",
      }),
      closeIssue: async (repo, issue, reason) => {
        closedCalls.push({ repo, issue, reason });
      },
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/11#issuecomment-2",
      }),
      listComments: async () => [],
    };

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T02:05:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });
    const out = await sync.syncLinkedTask(task_id);

    expect(out.action).toBe("pushed");
    expect(closedCalls).toEqual([{ repo: "acordeiro/penumbra", issue: 11, reason: "completed" }]);
  });

  test("syncAllLinkedTasks continues when one linked task errors", async () => {
    const { db, writer } = setup();
    const t1 = writer.file({
      prompt: "t1",
      created_by_kind: "human",
      created_by_id: "cli",
    }).task_id;
    const t2 = writer.file({
      prompt: "t2",
      created_by_kind: "human",
      created_by_id: "cli",
    }).task_id;
    const t3 = writer.file({
      prompt: "t3",
      created_by_kind: "human",
      created_by_id: "cli",
    }).task_id;
    writer.linkGhIssue(t1, { repo: "acordeiro/penumbra", issue_number: 21 });
    writer.linkGhIssue(t2, { repo: "acordeiro/penumbra", issue_number: 22 });
    writer.linkGhIssue(t3, { repo: "acordeiro/penumbra", issue_number: 23 });

    const viewed: number[] = [];
    const ghClient: GhClient = {
      createIssue: async () => {
        throw new Error("not used");
      },
      viewIssue: async (_repo, issue) => {
        viewed.push(issue);
        if (issue === 22) throw new Error("network down");
        return {
          number: issue,
          state: "OPEN",
          stateReason: null,
          updatedAt: "2026-05-08T00:00:00.000Z",
          title: `Issue ${issue}`,
          url: `https://github.com/acordeiro/penumbra/issues/${issue}`,
        };
      },
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/21#issuecomment-3",
      }),
      listComments: async () => [],
    };

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T03:00:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });
    const summary = await sync.syncAllLinkedTasks();

    expect(summary.linked).toBe(3);
    expect(summary.results).toHaveLength(3);
    expect(summary.errored).toBe(1);
    expect(new Set(viewed)).toEqual(new Set([21, 22, 23]));
  });

  test("syncLinkedTask warns with task and GH ref when sync fails", async () => {
    const { db, writer } = setup();
    const { task_id } = writer.file({
      prompt: "warn on error",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 24 });

    const warns: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    const ghClient: GhClient = {
      createIssue: async () => {
        throw new Error("not used");
      },
      viewIssue: async () => {
        const err = new Error("network down") as Error & { code?: string };
        err.code = "ETIMEDOUT";
        throw err;
      },
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/24#issuecomment-7",
      }),
      listComments: async () => [],
    };

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T03:00:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
      log: {
        warn: (obj, msg) => {
          warns.push({ obj: obj as Record<string, unknown>, msg });
        },
      },
    });

    const result = await sync.syncLinkedTask(task_id);

    expect(result.action).toBe("error");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toBe("gh-task-sync: linked task sync failed");
    expect(warns[0]?.obj).toMatchObject({
      taskId: task_id,
      ghRef: "acordeiro/penumbra#24",
      err: "network down",
      code: "ETIMEDOUT",
    });
  });

  test("syncAllLinkedTasks clamps gh_create_issue titles before calling GitHub", async () => {
    const { db, writer } = setup();
    const { task_id } = writer.file({
      prompt: "create issue title clamp",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.enqueueGhOutbox(task_id, "gh_create_issue", {
      repo: "acordeiro/penumbra",
      title: `line one\n${"x".repeat(1200)}\nline three`,
      body: "full body",
    });

    const createCalls: Array<{ repo: string; title: string; body: string }> = [];
    const ghClient: GhClient = {
      createIssue: async (input) => {
        createCalls.push(input);
        return {
          number: 99,
          title: input.title,
          url: "https://github.com/acordeiro/penumbra/issues/99",
        };
      },
      viewIssue: async () => {
        throw new Error("not used");
      },
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/99#issuecomment-1",
      }),
      listComments: async () => [],
    };

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T03:00:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });

    await sync.syncAllLinkedTasks({ fullReconcile: false });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.repo).toBe("acordeiro/penumbra");
    expect(createCalls[0]?.title).toMatch(/^[^\n]+$/);
    expect(createCalls[0]?.title.length).toBeLessThanOrEqual(256);
    expect(createCalls[0]?.title).toContain("line one");
    expect(createCalls[0]?.body).toBe("full body");
  });

  test("syncAllLinkedTasks skips GitHub side effects when gh_outbox claim loses", async () => {
    const { db, writer } = setup();
    const { task_id } = writer.file({
      prompt: "create issue once",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    const row = {
      id: 1,
      task_id,
      op: "gh_create_issue" as const,
      payload_json: JSON.stringify({
        repo: "acordeiro/penumbra",
        title: "Create once",
        body: "body",
      }),
      status: "pending",
      created_at: 1,
      attempted_at: null,
      completed_at: null,
      error: null,
    };

    let claimAttempts = 0;
    const taskWriter = {
      get: writer.get.bind(writer),
      cancel: writer.cancel.bind(writer),
      completeWithoutLease: writer.completeWithoutLease.bind(writer),
      reopenFromGh: writer.reopenFromGh.bind(writer),
      linkGhIssue: writer.linkGhIssue.bind(writer),
      listLinkedTasks: writer.listLinkedTasks.bind(writer),
      setGhLastCommentId: writer.setGhLastCommentId.bind(writer),
      setGhCommentsSyncedAt: writer.setGhCommentsSyncedAt.bind(writer),
      setGhCreateStatus: writer.setGhCreateStatus.bind(writer),
      enqueueGhOutbox: writer.enqueueGhOutbox.bind(writer),
      listPendingGhOutbox: () => [row],
      markGhOutboxAttempt: () => {
        claimAttempts += 1;
        return claimAttempts === 1;
      },
      requeueStaleGhOutboxProcessing: () => 0,
      markGhOutboxDone: writer.markGhOutboxDone.bind(writer),
      markGhOutboxFailed: writer.markGhOutboxFailed.bind(writer),
    };

    const createCalls: { repo: string; title: string; body: string }[] = [];
    const ghClient: GhClient = {
      createIssue: async (input) => {
        createCalls.push(input);
        return {
          number: 99,
          title: input.title,
          url: "https://github.com/acordeiro/penumbra/issues/99",
        };
      },
      viewIssue: async () => {
        throw new Error("not used");
      },
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/99#issuecomment-1",
      }),
      listComments: async () => [],
    };

    const sync = createGhTaskSyncService({
      taskWriter,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T03:00:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });

    await Promise.all([
      sync.syncAllLinkedTasks({ fullReconcile: false }),
      sync.syncAllLinkedTasks({ fullReconcile: false }),
    ]);

    expect(claimAttempts).toBe(2);
    expect(createCalls).toHaveLength(1);
  });

  test("syncAllLinkedTasks processes linked tasks in parallel batches", async () => {
    const { db, writer } = setup();
    for (let i = 1; i <= 6; i += 1) {
      const taskId = writer.file({
        prompt: `t${i}`,
        created_by_kind: "human",
        created_by_id: "cli",
      }).task_id;
      writer.linkGhIssue(taskId, { repo: "acordeiro/penumbra", issue_number: 100 + i });
    }

    let active = 0;
    let maxActive = 0;
    const ghClient: GhClient = {
      createIssue: async () => {
        throw new Error("not used");
      },
      viewIssue: async (_repo, issue) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(10);
        active -= 1;
        return {
          number: issue,
          state: "OPEN",
          stateReason: null,
          updatedAt: "2026-05-08T00:00:00.000Z",
          title: `Issue ${issue}`,
          url: `https://github.com/acordeiro/penumbra/issues/${issue}`,
        };
      },
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/101#issuecomment-4",
      }),
      listComments: async () => [],
    };

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T03:00:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });
    await sync.syncAllLinkedTasks();
    expect(maxActive).toBeGreaterThan(1);
  });

  test("syncLinkedTask mirrors non-penumbra comments and advances gh_last_comment_id", async () => {
    const { db, writer } = setup();
    const { task_id } = writer.file({
      prompt: "mirror comments",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 55 });

    const ghClient: GhClient = {
      viewIssue: async () => ({
        number: 55,
        state: "OPEN",
        stateReason: null,
        updatedAt: "2026-05-08T03:00:00.000Z",
        title: "Issue 55",
        url: "https://github.com/acordeiro/penumbra/issues/55",
      }),
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/55#issuecomment-6",
      }),
      listComments: async () => [
        {
          id: "1001",
          author_login: "penumbra-bot",
          body: "<!-- penumbra:source=task:task_x kind=status_change ts=2026-05-08T03:00:00.000Z -->",
          created_at: "2026-05-08T03:00:00.000Z",
          url: "https://github.com/acordeiro/penumbra/issues/55#issuecomment-1001",
        },
        {
          id: "1002",
          author_login: "octocat",
          body: "can we add test coverage?",
          created_at: "2026-05-08T03:01:00.000Z",
          url: "https://github.com/acordeiro/penumbra/issues/55#issuecomment-1002",
        },
      ],
      getAuthenticatedLogin: async () => "penumbra-bot",
    };

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T03:05:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });
    const out = await sync.syncLinkedTask(task_id);
    expect(out.action).toBe("noop");

    const mirrored = db
      .query<{ event_type: string; payload_json: string }, []>(
        `SELECT event_type, payload_json
         FROM t0_events
         WHERE event_type = 'gh_issue_comment'
         ORDER BY ts ASC`,
      )
      .all();
    expect(mirrored).toHaveLength(1);
    const payload = JSON.parse(mirrored[0]!.payload_json);
    expect(payload.comment_id).toBe("1002");
    expect(payload.author_login).toBe("octocat");
    expect(writer.get(task_id).gh_last_comment_id).toBe("1002");
  });

  test("comment sync cursor is decoupled from task.updated_at and does not skip comments after status changes", async () => {
    const { db, writer, setNow } = setup();
    const { task_id } = writer.file({
      prompt: "cursor decoupling",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 80 });

    const seenSince: Array<string | undefined> = [];
    let pass = 0;
    const ghClient: GhClient = {
      viewIssue: async () => ({
        number: 80,
        state: "OPEN",
        stateReason: null,
        updatedAt: "2026-05-08T03:00:00.000Z",
        title: "Issue 80",
        url: "https://github.com/acordeiro/penumbra/issues/80",
      }),
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/80#issuecomment-1",
      }),
      listComments: async (_repo, _issue, opts) => {
        seenSince.push(opts?.since);
        pass += 1;
        if (pass === 1) return [];
        return [
          {
            id: "8001",
            author_login: "octocat",
            body: "status changed but this should still mirror",
            created_at: "2026-05-08T03:01:30.000Z",
            url: "https://github.com/acordeiro/penumbra/issues/80#issuecomment-8001",
          },
        ];
      },
      getAuthenticatedLogin: async () => "penumbra-bot",
    };

    setNow(Date.parse("2026-05-08T03:01:00.000Z"));
    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T03:01:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });
    await sync.syncLinkedTask(task_id);

    // Local status mutation advances task.updated_at, but must not be used as comment cursor.
    setNow(Date.parse("2026-05-08T03:02:00.000Z"));
    writer.cancel({ task_id, reason: "local change" });

    await sync.syncLinkedTask(task_id);

    const mirrored = db
      .query<
        { c: number },
        []
      >(`SELECT COUNT(*) AS c FROM t0_events WHERE event_type = 'gh_issue_comment'`)
      .get();
    expect(mirrored?.c).toBe(1);
    expect(seenSince).toEqual([undefined, "2026-05-08T03:01:00.000Z"]);
  });

  test("task touch does not advance gh comment cursor", async () => {
    const { db, writer } = setup();
    const { task_id } = writer.file({
      prompt: "touch should not move comment cursor",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 81 });
    db.run(`UPDATE tasks SET gh_comments_synced_at = ? WHERE id = ?`, [
      Date.parse("2026-05-08T03:10:00.000Z"),
      task_id,
    ]);

    const before = writer.get(task_id).gh_comments_synced_at;
    writer.touch(task_id);
    const after = writer.get(task_id).gh_comments_synced_at;

    expect(before).toBe(Date.parse("2026-05-08T03:10:00.000Z"));
    expect(after).toBe(before);
  });

  test("syncLinkedTask uses per-task in-memory lock and returns already_in_progress for concurrent calls", async () => {
    const { db, writer } = setup();
    const { task_id } = writer.file({
      prompt: "lock me",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 82 });

    let viewCalls = 0;
    const ghClient: GhClient = {
      viewIssue: async () => {
        viewCalls += 1;
        await Bun.sleep(20);
        return {
          number: 82,
          state: "OPEN",
          stateReason: null,
          updatedAt: "2026-05-08T03:00:00.000Z",
          title: "Issue 82",
          url: "https://github.com/acordeiro/penumbra/issues/82",
        };
      },
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/82#issuecomment-1",
      }),
      listComments: async () => [],
      getAuthenticatedLogin: async () => "penumbra-bot",
    };

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T03:05:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });

    const [first, second] = await Promise.all([
      sync.syncLinkedTask(task_id),
      sync.syncLinkedTask(task_id),
    ]);

    const results = [first, second];
    expect(viewCalls).toBe(1);
    expect(results.some((r) => r.action === "already_in_progress")).toBe(true);
    expect(results.some((r) => r.action === "noop")).toBe(true);
  });

  test("pushStatusNow re-reads issue state after push and returns fresh gh_state", async () => {
    const { db, writer, setNow } = setup();
    const { task_id } = writer.file({
      prompt: "done task",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "acordeiro/penumbra", issue_number: 31 });
    setNow(Date.parse("2026-05-08T02:00:00.000Z"));
    db.run(`UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`, [
      Date.parse("2026-05-08T02:00:00.000Z"),
      task_id,
    ]);

    let viewCalls = 0;
    const ghClient: GhClient = {
      createIssue: async () => {
        throw new Error("not used");
      },
      viewIssue: async () => {
        viewCalls += 1;
        return {
          number: 31,
          state: viewCalls === 1 ? "OPEN" : "CLOSED",
          stateReason: null,
          updatedAt: "2026-05-08T00:30:00.000Z",
          title: "Issue 31",
          url: "https://github.com/acordeiro/penumbra/issues/31",
        };
      },
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => ({
        comment_url: "https://github.com/acordeiro/penumbra/issues/31#issuecomment-5",
      }),
      listComments: async () => [],
    };

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T02:05:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });
    const out = await sync.pushStatusNow(task_id);
    expect(out?.action).toBe("pushed");
    expect(out?.gh_state).toBe("CLOSED");
    expect(viewCalls).toBe(2);
  });

  test("sweeper emits skip_tick and does not overlap while prior tick is in flight", async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    const warns: unknown[] = [];
    const service = {
      syncAllLinkedTasks: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          linked: 0,
          pushed: 0,
          pulled: 0,
          errored: 0,
          skipped: false,
          results: [],
        };
      },
    };

    const sweeper = createGhTaskSyncSweeper({
      service: service as any,
      intervalMs: 1,
      log: {
        warn: (obj: unknown) => {
          warns.push(obj);
        },
      },
    });

    sweeper.start();
    await Bun.sleep(20);
    sweeper.stop();
    release?.();
    await Bun.sleep(1);

    expect(calls).toBe(1);
    expect(
      warns.some(
        (row: any) => row?.event === "sweeper.skip_tick" && row?.sweeper === "gh-task-sync",
      ),
    ).toBe(true);
  });
});
