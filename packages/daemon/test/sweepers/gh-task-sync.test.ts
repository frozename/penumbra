import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { createDaemonFetchHandler } from "@src/serve.js";
import type {
  GhClient,
  GhCreateIssueInput,
  GhIssueComment,
  GhIssueView,
} from "@src/services/gh-client.js";
import {
  createGhTaskSyncService,
  createGhTaskSyncSingleFlight,
  createGhTaskSyncSweeper,
  type GhTaskSyncService,
  type GhTaskSyncSummary,
} from "@src/sweepers/gh-task-sync.js";

import type { Services } from "../../../core/src/index.js";

import { loadSqliteVec, migrate, T0Writer, TaskWriter } from "../../../core/src/index.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // Custom sqlite path is best-effort on non-Homebrew machines.
}

interface SetupHandle {
  db: Database;
  writer: TaskWriter;
  setNow: (ms: number) => void;
}

function setup(): SetupHandle {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let nowMs = Date.parse("2026-05-08T00:00:00.000Z");
  const writer = new TaskWriter(db, { now: (): number => nowMs });
  return {
    db,
    writer,
    setNow: (ms: number): void => {
      nowMs = ms;
    },
  };
}

const rejectNotUsed = <T>(): Promise<T> => Promise.reject(new Error("not used"));
const resolveVoid = (): Promise<void> => Promise.resolve();
const resolveEmptyComments = (): Promise<GhIssueComment[]> => Promise.resolve([]);

function makeGhClient(overrides: Partial<GhClient>): GhClient {
  const base: GhClient = {
    createIssue: () => rejectNotUsed<{ number: number; url: string }>(),
    viewIssue: () => rejectNotUsed<GhIssueView>(),
    closeIssue: () => resolveVoid(),
    reopenIssue: () => resolveVoid(),
    commentIssue: (_repo: string, issue: number) =>
      Promise.resolve({
        comment_url: `https://github.com/frozename/penumbra/issues/${String(issue)}#issuecomment-1`,
      }),
    listComments: () => resolveEmptyComments(),
  };
  return { ...base, ...overrides };
}

function viewOpen(issue: number, updatedAt = "2026-05-08T00:00:00.000Z"): GhIssueView {
  return {
    number: issue,
    state: "OPEN",
    stateReason: null,
    updatedAt,
    title: `Issue ${String(issue)}`,
    url: `https://github.com/frozename/penumbra/issues/${String(issue)}`,
  };
}

function viewClosed(
  issue: number,
  stateReason: GhIssueView["stateReason"],
  updatedAt = "2026-05-08T01:00:00.000Z",
): GhIssueView {
  return {
    number: issue,
    state: "CLOSED",
    stateReason,
    updatedAt,
    title: `Issue ${String(issue)}`,
    url: `https://github.com/frozename/penumbra/issues/${String(issue)}`,
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
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 10 });

    const ghClient = makeGhClient({
      viewIssue: () => Promise.resolve(viewClosed(10, "NOT_PLANNED")),
    });

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
    const eventPayload = JSON.parse(event?.payload_json ?? "{}") as { task_id?: string };
    expect(eventPayload.task_id).toBe(task_id);
  });

  test("GH CLOSED+COMPLETED pulls to done", async () => {
    const { db, writer, setNow } = setup();
    const { task_id } = writer.file({
      prompt: "completed issue",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 12 });

    const ghClient = makeGhClient({
      viewIssue: () => Promise.resolve(viewClosed(12, "COMPLETED")),
    });

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
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 13 });

    const ghClient = makeGhClient({
      viewIssue: () => Promise.resolve(viewClosed(13, "NOT_PLANNED")),
    });

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
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 14 });

    const ghClient = makeGhClient({
      viewIssue: () => Promise.resolve(viewClosed(14, null)),
    });

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
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 11 });

    setNow(Date.parse("2026-05-08T02:00:00.000Z"));
    db.run(`UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`, [
      Date.parse("2026-05-08T02:00:00.000Z"),
      task_id,
    ]);

    const closedCalls: { repo: string; issue: number; reason: "completed" | "not planned" }[] = [];
    const ghClient = makeGhClient({
      viewIssue: () => Promise.resolve(viewOpen(11, "2026-05-08T00:30:00.000Z")),
      closeIssue: (repo, issue, reason) => {
        closedCalls.push({ repo, issue, reason });
        return Promise.resolve();
      },
    });

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
    expect(closedCalls).toEqual([{ repo: "frozename/penumbra", issue: 11, reason: "completed" }]);
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
    writer.linkGhIssue(t1, { repo: "frozename/penumbra", issue_number: 21 });
    writer.linkGhIssue(t2, { repo: "frozename/penumbra", issue_number: 22 });
    writer.linkGhIssue(t3, { repo: "frozename/penumbra", issue_number: 23 });

    const viewed: number[] = [];
    const ghClient = makeGhClient({
      viewIssue: (_repo, issue) => {
        viewed.push(issue);
        if (issue === 22) return Promise.reject(new Error("network down"));
        return Promise.resolve(viewOpen(issue));
      },
    });

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
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 24 });

    const warns: { obj: Record<string, unknown>; msg?: string }[] = [];
    const ghClient = makeGhClient({
      viewIssue: () => {
        const err = new Error("network down") as Error & { code?: string };
        err.code = "ETIMEDOUT";
        return Promise.reject(err);
      },
    });

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
      ghRef: "frozename/penumbra#24",
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
      repo: "frozename/penumbra",
      title: `line one\n${"x".repeat(1200)}\nline three`,
      body: "full body",
    });

    const createCalls: GhCreateIssueInput[] = [];
    const ghClient = makeGhClient({
      createIssue: (input) => {
        createCalls.push(input);
        return Promise.resolve({
          number: 99,
          url: "https://github.com/frozename/penumbra/issues/99",
        });
      },
    });

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
    expect(createCalls[0]?.repo).toBe("frozename/penumbra");
    expect(createCalls[0]?.title).toMatch(/^[^\n]+$/);
    expect((createCalls[0]?.title ?? "").length).toBeLessThanOrEqual(256);
    expect(createCalls[0]?.title).toContain("line one");
    expect(createCalls[0]?.body).toContain("full body");
    expect(createCalls[0]?.body).toMatch(/<!-- penumbra-outbox-id=\d+ -->/);
  });

  test("syncAllLinkedTasks does not duplicate createIssue when stale requeue sees an in-flight row", async () => {
    const { db, writer, setNow } = setup();
    const startedAt = Date.parse("2026-05-08T03:00:00.000Z");
    setNow(startedAt);
    let setupNow = startedAt;
    const { task_id } = writer.file({
      prompt: "create issue once across stale race",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.enqueueGhOutbox(task_id, "gh_create_issue", {
      repo: "frozename/penumbra",
      title: "Create once",
      body: "body",
    });

    let releaseCreate: (() => void) | null = null;
    const firstCreateStarted = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createCalls: GhCreateIssueInput[] = [];
    const ghClient = makeGhClient({
      createIssue: async (input) => {
        createCalls.push(input);
        if (createCalls.length === 1) {
          await firstCreateStarted;
        }
        return {
          number: 99,
          url: "https://github.com/frozename/penumbra/issues/99",
        };
      },
    });

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date(setupNow),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });

    const first = sync.syncAllLinkedTasks({ fullReconcile: false });
    while (createCalls.length === 0) {
      await Bun.sleep(1);
    }

    setupNow = startedAt + 11 * 60 * 1000;
    await sync.syncAllLinkedTasks({ fullReconcile: false });
    releaseCreate?.();
    await first;

    // Pins the stale-requeue in-flight guard and status-guarded completion: the
    // in-flight call must not run GitHub twice or clobber the requeued row done.
    expect(createCalls).toHaveLength(1);
    const row = db
      .query<{ status: string }, []>(`SELECT status FROM gh_outbox ORDER BY id DESC LIMIT 1`)
      .get();
    expect(row?.status).toBe("pending");

    await sync.syncAllLinkedTasks({ fullReconcile: false });
    expect(createCalls).toHaveLength(1);
    const row2 = db
      .query<{ status: string }, []>(`SELECT status FROM gh_outbox ORDER BY id DESC LIMIT 1`)
      .get();
    expect(row2?.status).toBe("done");
  });

  test("syncAllLinkedTasks skips GitHub side effects when real gh_outbox claim loses", async () => {
    const { writer } = setup();
    const { task_id } = writer.file({
      prompt: "create issue once",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.enqueueGhOutbox(task_id, "gh_create_issue", {
      repo: "frozename/penumbra",
      title: "Create once",
      body: "body",
    });
    const [row] = writer.listPendingGhOutbox(10);
    expect(row).toBeDefined();

    const createCalls: GhCreateIssueInput[] = [];
    const ghClient = makeGhClient({
      createIssue: (input) => {
        createCalls.push(input);
        return Promise.resolve({
          number: 99,
          url: "https://github.com/frozename/penumbra/issues/99",
        });
      },
    });

    async function claimAndCreate(snapshot: typeof row): Promise<void> {
      if (!snapshot) return;
      const won = writer.markGhOutboxAttempt(snapshot.id);
      if (!won) return;
      const payload = JSON.parse(snapshot.payload_json) as {
        repo: string;
        title: string;
        body: string;
      };
      await ghClient.createIssue(payload);
      writer.markGhOutboxDone(snapshot.id);
    }

    await Promise.all([claimAndCreate(row), claimAndCreate(row)]);

    expect(createCalls).toHaveLength(1);
  });

  test("syncAllLinkedTasks processes linked tasks in parallel batches", async () => {
    const { db, writer } = setup();
    for (let i = 1; i <= 6; i += 1) {
      const taskId = writer.file({
        prompt: `t${String(i)}`,
        created_by_kind: "human",
        created_by_id: "cli",
      }).task_id;
      writer.linkGhIssue(taskId, { repo: "frozename/penumbra", issue_number: 100 + i });
    }

    let active = 0;
    let maxActive = 0;
    const ghClient = makeGhClient({
      viewIssue: async (_repo, issue) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(10);
        active -= 1;
        return viewOpen(issue);
      },
    });

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
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 55 });

    const ghClient = makeGhClient({
      viewIssue: () => Promise.resolve(viewOpen(55, "2026-05-08T03:00:00.000Z")),
      listComments: () =>
        Promise.resolve<GhIssueComment[]>([
          {
            id: "1001",
            author_login: "penumbra-bot",
            body: "<!-- penumbra:source=task:task_x kind=status_change ts=2026-05-08T03:00:00.000Z -->",
            created_at: "2026-05-08T03:00:00.000Z",
            url: "https://github.com/frozename/penumbra/issues/55#issuecomment-1001",
          },
          {
            id: "1002",
            author_login: "octocat",
            body: "can we add test coverage?",
            created_at: "2026-05-08T03:01:00.000Z",
            url: "https://github.com/frozename/penumbra/issues/55#issuecomment-1002",
          },
        ]),
      getAuthenticatedLogin: () => Promise.resolve("penumbra-bot"),
    });

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
    const payload = JSON.parse(mirrored[0]!.payload_json) as {
      comment_id?: string;
      author_login?: string;
    };
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
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 80 });

    const seenSince: (string | undefined)[] = [];
    let pass = 0;
    const ghClient = makeGhClient({
      viewIssue: () => Promise.resolve(viewOpen(80, "2026-05-08T03:00:00.000Z")),
      listComments: (_repo, _issue, opts) => {
        seenSince.push(opts?.since);
        pass += 1;
        if (pass === 1) return Promise.resolve<GhIssueComment[]>([]);
        return Promise.resolve<GhIssueComment[]>([
          {
            id: "8001",
            author_login: "octocat",
            body: "status changed but this should still mirror",
            created_at: "2026-05-08T03:01:30.000Z",
            url: "https://github.com/frozename/penumbra/issues/80#issuecomment-8001",
          },
        ]);
      },
      getAuthenticatedLogin: () => Promise.resolve("penumbra-bot"),
    });

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

  test("mirrorInboundComments stamps cursor at pre-fetch time so mid-sweep comments are not lost", async () => {
    const { db, writer } = setup();
    const { task_id } = writer.file({
      prompt: "mid-sweep cursor race",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 90 });

    const preFetchMs = Date.parse("2026-05-08T04:00:00.000Z");
    const midSweepMs = Date.parse("2026-05-08T04:00:00.500Z");
    const postFetchMs = Date.parse("2026-05-08T04:00:01.000Z");
    const nextSweepMs = Date.parse("2026-05-08T04:00:05.000Z");

    let clock = preFetchMs;
    const now = (): Date => new Date(clock);

    let listCall = 0;
    const ghClient = makeGhClient({
      viewIssue: () => Promise.resolve(viewOpen(90, "2026-05-08T03:00:00.000Z")),
      listComments: (_repo, _issue, opts) => {
        listCall += 1;
        if (listCall === 1) {
          // Simulate wall-clock advancing across the awaited fetch: a real
          // GitHub call takes time and now() will read a later timestamp
          // after the await settles.
          clock = postFetchMs;
          return Promise.resolve<GhIssueComment[]>([]);
        }
        // Second sweep: server-side `since` filter mirrors GitHub semantics
        // (return comments with created_at >= since). The mid-sweep comment
        // must survive the filter for this test to pass.
        const sinceMs = opts?.since ? Date.parse(opts.since) : -Infinity;
        const all: GhIssueComment[] = [
          {
            id: "9001",
            author_login: "octocat",
            body: "created between fetch start and cursor stamp",
            created_at: new Date(midSweepMs).toISOString(),
            url: "https://github.com/frozename/penumbra/issues/90#issuecomment-9001",
          },
        ];
        return Promise.resolve<GhIssueComment[]>(
          all.filter((c) => Date.parse(c.created_at) >= sinceMs),
        );
      },
      getAuthenticatedLogin: () => Promise.resolve("penumbra-bot"),
    });

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now,
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
    });

    await sync.syncLinkedTask(task_id);

    clock = nextSweepMs;
    await sync.syncLinkedTask(task_id);

    const mirrored = db
      .query<
        { c: number },
        []
      >(`SELECT COUNT(*) AS c FROM t0_events WHERE event_type = 'gh_issue_comment'`)
      .get();
    expect(mirrored?.c).toBe(1);
  });

  test("task touch does not advance gh comment cursor", () => {
    const { db, writer } = setup();
    const { task_id } = writer.file({
      prompt: "touch should not move comment cursor",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 81 });
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
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 82 });

    let viewCalls = 0;
    const ghClient = makeGhClient({
      viewIssue: async () => {
        viewCalls += 1;
        await Bun.sleep(20);
        return viewOpen(82, "2026-05-08T03:00:00.000Z");
      },
      getAuthenticatedLogin: () => Promise.resolve("penumbra-bot"),
    });

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
    writer.linkGhIssue(task_id, { repo: "frozename/penumbra", issue_number: 31 });
    setNow(Date.parse("2026-05-08T02:00:00.000Z"));
    db.run(`UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`, [
      Date.parse("2026-05-08T02:00:00.000Z"),
      task_id,
    ]);

    let viewCalls = 0;
    const ghClient = makeGhClient({
      viewIssue: () => {
        viewCalls += 1;
        if (viewCalls === 1) {
          return Promise.resolve(viewOpen(31, "2026-05-08T00:30:00.000Z"));
        }
        return Promise.resolve(viewClosed(31, null, "2026-05-08T00:30:00.000Z"));
      },
    });

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
    const warns: { event?: string; sweeper?: string }[] = [];
    const service: Pick<GhTaskSyncService, "syncAllLinkedTasks"> = {
      syncAllLinkedTasks: async (): Promise<GhTaskSyncSummary> => {
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
      // The sweeper only exercises syncAllLinkedTasks; a Pick is sufficient.
      service: service as unknown as GhTaskSyncService,
      intervalMs: 1,
      log: {
        warn: (obj: unknown): void => {
          warns.push(obj as { event?: string; sweeper?: string });
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
      warns.some((row) => row.event === "sweeper.skip_tick" && row.sweeper === "gh-task-sync"),
    ).toBe(true);
  });

  test("retry of gh_create_issue whose createIssue succeeded but linkGhIssue did not does NOT create a duplicate", async () => {
    // Simulates: previous attempt called ghClient.createIssue (issue #999 was
    // created on GitHub) but the daemon crashed before linkGhIssue ran, leaving
    // the gh_outbox row in 'processing'. After the 10-min stale window,
    // requeueStaleGhOutboxProcessing flips the row back to 'pending'. Without
    // the idempotency probe, the next attempt would call createIssue a second
    // time and produce a duplicate GitHub issue.
    const { db, writer, setNow } = setup();
    const startedAt = Date.parse("2026-05-08T03:00:00.000Z");
    setNow(startedAt);
    let setupNow = startedAt;
    const { task_id } = writer.file({
      prompt: "retry idempotency",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.enqueueGhOutbox(task_id, "gh_create_issue", {
      repo: "frozename/penumbra",
      title: "Idempotent create",
      body: "issue body",
    });
    const [pendingRow] = writer.listPendingGhOutbox(10);
    expect(pendingRow).toBeDefined();
    expect(writer.markGhOutboxAttempt(pendingRow!.id)).toBe(true);

    setupNow = startedAt + 11 * 60 * 1000;
    setNow(setupNow);

    const createCalls: GhCreateIssueInput[] = [];
    const ghClient = makeGhClient({
      createIssue: (input) => {
        createCalls.push(input);
        return Promise.resolve({
          number: 1000,
          url: "https://github.com/frozename/penumbra/issues/1000",
        });
      },
    });

    const markerCalls: { repo: string; marker: string }[] = [];
    const findOpenIssueByMarker = (
      repo: string,
      marker: string,
    ): Promise<{ number: number } | null> => {
      markerCalls.push({ repo, marker });
      return Promise.resolve({ number: 999 });
    };

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date(setupNow),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
      findOpenIssueByMarker,
    });

    await sync.syncAllLinkedTasks({ fullReconcile: false });

    expect(createCalls).toHaveLength(0);
    expect(markerCalls).toHaveLength(1);
    expect(markerCalls[0]?.repo).toBe("frozename/penumbra");
    expect(markerCalls[0]?.marker).toMatch(/^<!-- penumbra-outbox-id=\d+ -->$/);

    const task = writer.get(task_id);
    expect(task.gh_issue_number).toBe(999);
    expect(task.gh_issue_repo).toBe("frozename/penumbra");

    const row = db
      .query<{ status: string }, [string]>(`SELECT status FROM gh_outbox WHERE task_id = ?`)
      .get(task_id);
    expect(row?.status).toBe("done");
  });

  test("first-attempt gh_create_issue embeds the idempotency marker in the issue body", async () => {
    const { db, writer } = setup();
    const { task_id } = writer.file({
      prompt: "marker embedded",
      created_by_kind: "human",
      created_by_id: "cli",
    });
    writer.enqueueGhOutbox(task_id, "gh_create_issue", {
      repo: "frozename/penumbra",
      title: "marker create",
      body: "original body",
    });

    const createCalls: GhCreateIssueInput[] = [];
    const ghClient = makeGhClient({
      createIssue: (input) => {
        createCalls.push(input);
        return Promise.resolve({
          number: 42,
          url: "https://github.com/frozename/penumbra/issues/42",
        });
      },
    });

    const findOpenIssueByMarker = (): Promise<{ number: number } | null> => Promise.resolve(null);

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date("2026-05-08T03:00:00.000Z"),
      uuid: () => crypto.randomUUID(),
      userId: "test-user",
      machineId: "test-machine",
      findOpenIssueByMarker,
    });

    await sync.syncAllLinkedTasks({ fullReconcile: false });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.body).toContain("original body");
    expect(createCalls[0]?.body).toMatch(/<!-- penumbra-outbox-id=\d+ -->/);
  });

  test("createDaemonFetchHandler uses provided ghTaskSyncService without re-wrapping (Bug A)", async () => {
    let callCount = 0;
    const baseService: Pick<GhTaskSyncService, "syncAllLinkedTasks"> = {
      syncAllLinkedTasks: async (): Promise<GhTaskSyncSummary> => {
        callCount++;
        await Bun.sleep(10);
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

    // The single-flight wrapper only consults syncAllLinkedTasks for the gate
    // exercised here; the rest of the GhTaskSyncService surface is unused.
    const singleFlightService = createGhTaskSyncSingleFlight(
      baseService as unknown as GhTaskSyncService,
    );

    const { db, writer } = setup();

    // Bug A only exercises the route's single-flight dispatch path. Providing
    // the minimum Services shape that createDaemonFetchHandler reads is enough.
    const noopWarn = (): void => undefined;
    const mockServices = {
      log: { warn: noopWarn },
      db,
      workerManager: {
        getWorkers: (): unknown[] => [],
      },
    } as unknown as Services;

    const handler = createDaemonFetchHandler({
      services: mockServices,
      token: "test-token",
      ghTaskSyncService: singleFlightService,
      taskWriter: writer,
    });

    const p1 = singleFlightService.syncAllLinkedTasks();
    const req = new Request("http://localhost/tasks/sync-gh-now", {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
    });
    const p2 = handler(req);

    await Promise.all([p1, p2]);

    // Because singleFlightService is shared and NOT re-wrapped, the second call
    // (the HTTP request) immediately hits the single flight lock and returns the skipped summary.
    // The inner baseService is only called once.
    expect(callCount).toBe(1);
  });
});
