import {
  HandoffReader,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  type Services,
  type WorktreeHandle,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { lifecycleLock, resetLifecycleLock } from "../../src/dispatch/lifecycle-lock.js";
import { runWorktreeGcTick } from "../../src/sweepers/worktree-gc.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  noop();
}

function noop(): void {
  return undefined;
}

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeServices(
  db: Database,
  worktreeHandles: WorktreeHandle[],
  teardownSpy: (id: string, force?: boolean) => Promise<void>,
  orphanHandles: { path: string; handoffId: string }[] = [],
): Services {
  return {
    db,
    handoffWriter: new HandoffWriter({ db }),
    handoffReader: new HandoffReader({ db }),
    t0Writer: { write: noop },
    machineId: { get: () => "machine-test" },
    uuid: (() => {
      let n = 0;
      return () => `evt-${String(++n)}`;
    })(),
    clock: () => new Date(),
    log: { info: noop, warn: noop },
    worktreeManager: {
      listWorktrees: () => worktreeHandles,
      discoverOrphanWorktrees: () => Promise.resolve(orphanHandles),
      teardownWorktree: teardownSpy,
    },
  } as unknown as Services;
}

function insertHandoff(
  db: Database,
  handoff_id: string,
  status: string,
  resolved_at: string | null,
): void {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
       to_role, message, status, resolved_at, use_worktree, chain_task_type
     ) VALUES (?, '2026-05-01T00:00:00.000Z', NULL, ?, 'maestro', 'worker',
               NULL, 'do work', ?, ?, 1, 'implement_small')`,
    [handoff_id, `c-${handoff_id}`, status, resolved_at],
  );
}

function makeHandle(handoffId: string): WorktreeHandle {
  return {
    handoffId,
    path: `/tmp/worktrees/${handoffId}`,
    branchName: `agent/${handoffId}`,
    storageRoot: `/tmp/worktrees/${handoffId}/.test-storage`,
    createdAt: "2026-05-01T00:00:00.000Z",
    status: "created",
    worktreeMode: "symlink_mirror",
  };
}

function makeOrphan(handoffId: string): { path: string; handoffId: string } {
  return {
    handoffId,
    path: `/tmp/worktrees/${handoffId}`,
  };
}

const GRACE_MS = 2 * 60 * 60_000; // 2h
const NOW = new Date("2026-05-19T10:00:00.000Z");
const NOW_FN = (): Date => NOW;

describe("runWorktreeGcTick", () => {
  test("completed worktree resolved within grace is NOT removed", async () => {
    const db = setupDb();
    // resolved 1h ago — within 2h grace
    const resolvedAt = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    insertHandoff(db, "h-recent", "completed", resolvedAt);

    const teardownCalls: string[] = [];
    const svc = makeServices(db, [makeHandle("h-recent")], (id) => {
      teardownCalls.push(id);
      return Promise.resolve();
    });

    const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

    expect(result.candidates).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(teardownCalls).toEqual([]);
  });

  test("completed worktree resolved beyond grace IS removed", async () => {
    const db = setupDb();
    // resolved 3h ago — beyond 2h grace
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-old", "completed", resolvedAt);

    const teardownCalls: string[] = [];
    const svc = makeServices(db, [makeHandle("h-old")], (id) => {
      teardownCalls.push(id);
      return Promise.resolve();
    });

    const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

    expect(result.candidates).toEqual(["h-old"]);
    expect(result.removed).toEqual(["h-old"]);
    expect(result.failed).toEqual([]);
    expect(teardownCalls).toEqual(["h-old"]);
  });

  test("completed worktree resolved beyond grace is deferred while lifecycle lock is held", async () => {
    resetLifecycleLock();
    const release = await lifecycleLock.acquire("h-landing");
    try {
      const db = setupDb();
      const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
      insertHandoff(db, "h-deferred", "completed", resolvedAt);

      const teardownCalls: string[] = [];
      const svc = makeServices(db, [makeHandle("h-deferred")], (id) => {
        teardownCalls.push(id);
        return Promise.resolve();
      });

      const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

      expect(result.candidates).toEqual(["h-deferred"]);
      expect(result.removed).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.deferred).toEqual(["h-deferred"]);
      expect(teardownCalls).toEqual([]);
    } finally {
      release();
      resetLifecycleLock();
    }
  });

  test("dispatched worktree (in-flight) is NOT removed", async () => {
    const db = setupDb();
    insertHandoff(db, "h-live", "dispatched", null);

    const teardownCalls: string[] = [];
    const svc = makeServices(db, [makeHandle("h-live")], (id) => {
      teardownCalls.push(id);
      return Promise.resolve();
    });

    const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

    expect(result.candidates).toEqual([]);
    expect(teardownCalls).toEqual([]);
  });

  test("expired worktree resolved beyond grace IS removed", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 4 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-expired", "expired", resolvedAt);

    const teardownCalls: string[] = [];
    const svc = makeServices(db, [makeHandle("h-expired")], (id) => {
      teardownCalls.push(id);
      return Promise.resolve();
    });

    const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

    expect(result.removed).toContain("h-expired");
    expect(teardownCalls).toContain("h-expired");
  });

  test("emits worktree.gc dispatch event with expected meta per removal", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-ev", "completed", resolvedAt);

    const svc = makeServices(db, [makeHandle("h-ev")], () => Promise.resolve());

    const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

    expect(result.removed).toContain("h-ev");

    const row = db
      .query<
        { kind: string; meta_json: string },
        [string]
      >(`SELECT kind, meta_json FROM dispatch_events WHERE handoff_id = ? AND kind = 'worktree.gc'`)
      .get("h-ev");

    expect(row).toBeDefined();
    expect(row?.kind).toBe("worktree.gc");
    const meta = JSON.parse(row?.meta_json ?? "{}") as Record<string, unknown>;
    expect(meta.handoff_id).toBe("h-ev");
    expect(meta.branch_name).toBe("agent/h-ev");
    expect(meta.status).toBe("completed");
    expect(typeof meta.age_ms).toBe("number");
    expect(meta.age_ms as number).toBeGreaterThan(0);
  });

  test("terminal orphan worktree resolved beyond grace IS removed", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-orphan-old", "completed", resolvedAt);

    const teardownCalls: string[] = [];
    const svc = makeServices(
      db,
      [],
      (id) => {
        teardownCalls.push(id);
        return Promise.resolve();
      },
      [makeOrphan("h-orphan-old")],
    );

    const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

    expect(result.candidates).toEqual(["h-orphan-old"]);
    expect(result.removed).toEqual(["h-orphan-old"]);
    expect(result.failed).toEqual([]);
    expect(teardownCalls).toEqual(["h-orphan-old"]);
  });

  test("terminal orphan worktree resolved within grace is NOT removed", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    insertHandoff(db, "h-orphan-recent", "completed", resolvedAt);

    const teardownCalls: string[] = [];
    const svc = makeServices(
      db,
      [],
      (id) => {
        teardownCalls.push(id);
        return Promise.resolve();
      },
      [makeOrphan("h-orphan-recent")],
    );

    const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

    expect(result.candidates).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(teardownCalls).toEqual([]);
  });

  test("non-terminal orphan worktree is NOT removed", async () => {
    const db = setupDb();
    insertHandoff(db, "h-orphan-live", "dispatched", null);

    const teardownCalls: string[] = [];
    const svc = makeServices(
      db,
      [],
      (id) => {
        teardownCalls.push(id);
        return Promise.resolve();
      },
      [makeOrphan("h-orphan-live")],
    );

    const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

    expect(result.candidates).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(teardownCalls).toEqual([]);
  });
});
