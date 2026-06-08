import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, migrate, TaskWriter, T0Writer } from "@penumbra/core";
import type { GhClient } from "../../src/services/gh-client.js";
import {
  createGhTaskSyncService,
  createGhTaskSyncSweeper,
  type GhTaskSyncService,
  type GhTaskSyncSummary,
} from "../../src/sweepers/gh-task-sync.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

const noopGhClient: GhClient = {
  createIssue: async () => {
    throw new Error("unused");
  },
  viewIssue: async () => {
    throw new Error("unused");
  },
  closeIssue: async () => {},
  reopenIssue: async () => {},
  commentIssue: async () => ({ comment_url: "x" }),
  listComments: async () => [],
};

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeService(db: Database, writer: TaskWriter): GhTaskSyncService {
  return createGhTaskSyncService({
    taskWriter: writer,
    ghClient: noopGhClient,
    t0Writer: new T0Writer(db),
    now: () => new Date("2026-06-08T00:00:00.000Z"),
    uuid: () => crypto.randomUUID(),
    userId: "test",
    machineId: "test",
  });
}

describe("gh-task-sync full-reconcile throttle (Phase 3.1)", () => {
  test("syncAllLinkedTasks({fullReconcile:false}) skips listLinkedTasks but still drains the outbox", async () => {
    const db = freshDb();
    const writer = new TaskWriter(db);
    const svc = makeService(db, writer);

    let listCalls = 0;
    const origList = writer.listLinkedTasks.bind(writer);
    (writer as unknown as { listLinkedTasks: () => unknown }).listLinkedTasks = () => {
      listCalls++;
      return origList();
    };

    const outboxOnly = await svc.syncAllLinkedTasks({ fullReconcile: false });
    expect(listCalls).toBe(0);
    expect(outboxOnly.linked).toBe(0);
    expect(outboxOnly.skipped).toBe(false);

    const full = await svc.syncAllLinkedTasks();
    expect(listCalls).toBe(1);
  });

  test("sweeper full-reconciles on the first tick, then only after fullReconcileIntervalMs elapses", async () => {
    let nowMs = Date.parse("2026-06-08T00:00:00.000Z");
    const fullFlags: boolean[] = [];
    const fakeService = {
      syncAllLinkedTasks: async (o?: { fullReconcile?: boolean }): Promise<GhTaskSyncSummary> => {
        fullFlags.push(o?.fullReconcile !== false);
        return { linked: 0, pushed: 0, pulled: 0, errored: 0, skipped: false, results: [] };
      },
    } as unknown as GhTaskSyncService;

    const sweeper = createGhTaskSyncSweeper({
      service: fakeService,
      fullReconcileIntervalMs: 300_000,
      now: () => nowMs,
    });

    await sweeper.tick(); // first tick: lastFullReconcileAt=0 → full reconcile
    await sweeper.tick(); // same instant, within interval → outbox-only
    nowMs += 299_000;
    await sweeper.tick(); // still within 5min of last full → outbox-only
    nowMs += 2_000; // 301_000 since last full → full reconcile again
    await sweeper.tick();

    expect(fullFlags).toEqual([true, false, false, true]);
  });
});
