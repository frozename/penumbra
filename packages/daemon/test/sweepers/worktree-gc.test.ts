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
import { type BranchLandStatus, runWorktreeGcTick } from "../../src/sweepers/worktree-gc.js";

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

type TeardownReturn = { worktreeRemoved: boolean; branchDeleted: boolean; branchSha?: string };
type TeardownSpy = (id: string, force?: boolean) => Promise<TeardownReturn | undefined>;

function makeServices(
  db: Database,
  worktreeHandles: WorktreeHandle[],
  teardownSpy: TeardownSpy,
  orphanHandles: { path: string; handoffId: string }[] = [],
): Services {
  // Default-fill the new wider teardown shape when the spy returns void so the
  // F21 worktreeRemoved gate behaves as before for existing tests.
  const wrappedTeardown = async (id: string, force?: boolean): Promise<TeardownReturn> => {
    const raw = await teardownSpy(id, force);
    if (raw && typeof raw === "object") return raw;
    return { worktreeRemoved: true, branchDeleted: true };
  };
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
      teardownWorktree: wrappedTeardown,
      mainRepoDir: "/tmp/main-repo",
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

// Default stub: assume every probed branch is landed so existing scenarios
// exercise the post-guard teardown path. Tests that want to exercise the
// guard pass an explicit stub.
const ALWAYS_LANDED = (): Promise<BranchLandStatus> => Promise.resolve("landed");

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

    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

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

    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

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

      const result = await runWorktreeGcTick(
        { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
        NOW_FN,
      );

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

    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

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

    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

    expect(result.removed).toContain("h-expired");
    expect(teardownCalls).toContain("h-expired");
  });

  test("emits worktree.gc dispatch event with expected meta per removal", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-ev", "completed", resolvedAt);

    const svc = makeServices(db, [makeHandle("h-ev")], () => Promise.resolve());

    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

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

    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

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

    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

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

    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

    expect(result.candidates).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(teardownCalls).toEqual([]);
  });

  test("unlanded branch is deferred, emits worktree.gc.unlanded_skipped event, and is NOT removed", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-unlanded", "completed", resolvedAt);

    const teardownCalls: string[] = [];
    const probedBranches: string[] = [];
    const svc = makeServices(db, [makeHandle("h-unlanded")], (id) => {
      teardownCalls.push(id);
      return Promise.resolve();
    });

    const result = await runWorktreeGcTick(
      {
        services: svc,
        gracePeriodMs: GRACE_MS,
        branchLandedCheck: (branch) => {
          probedBranches.push(branch);
          return Promise.resolve("unlanded");
        },
      },
      NOW_FN,
    );

    expect(probedBranches).toEqual(["agent/h-unlanded"]);
    expect(result.candidates).toEqual(["h-unlanded"]);
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.deferred).toEqual(["h-unlanded"]);
    expect(result.unlanded_skipped).toEqual(["h-unlanded"]);
    expect(teardownCalls).toEqual([]);

    const row = db
      .query<{ kind: string; meta_json: string }, [string]>(
        `SELECT kind, meta_json FROM dispatch_events
         WHERE handoff_id = ? AND kind = 'worktree.gc.unlanded_skipped'`,
      )
      .get("h-unlanded");

    expect(row).toBeDefined();
    expect(row?.kind).toBe("worktree.gc.unlanded_skipped");
    const meta = JSON.parse(row?.meta_json ?? "{}") as Record<string, unknown>;
    expect(meta.handoff_id).toBe("h-unlanded");
    expect(meta.branch).toBe("agent/h-unlanded");
    expect(meta.land_status).toBe("unlanded");

    // No worktree.gc event for the unlanded candidate.
    const reapRow = db
      .query<
        { kind: string },
        [string]
      >(`SELECT kind FROM dispatch_events WHERE handoff_id = ? AND kind = 'worktree.gc'`)
      .get("h-unlanded");
    expect(reapRow).toBeNull();
  });

  test("landed branch IS removed and emits worktree.gc with land_status=landed", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-landed", "completed", resolvedAt);

    const teardownCalls: string[] = [];
    const svc = makeServices(db, [makeHandle("h-landed")], (id) => {
      teardownCalls.push(id);
      return Promise.resolve();
    });

    const result = await runWorktreeGcTick(
      {
        services: svc,
        gracePeriodMs: GRACE_MS,
        branchLandedCheck: () => Promise.resolve("landed"),
      },
      NOW_FN,
    );

    expect(result.removed).toEqual(["h-landed"]);
    expect(result.deferred).toEqual([]);
    expect(result.unlanded_skipped).toEqual([]);
    expect(teardownCalls).toEqual(["h-landed"]);

    const row = db
      .query<
        { meta_json: string },
        [string]
      >(`SELECT meta_json FROM dispatch_events WHERE handoff_id = ? AND kind = 'worktree.gc'`)
      .get("h-landed");
    const meta = JSON.parse(row?.meta_json ?? "{}") as Record<string, unknown>;
    expect(meta.land_status).toBe("landed");
  });

  test("missing branch ref IS removed (orphan with no ref)", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-noref", "completed", resolvedAt);

    const teardownCalls: string[] = [];
    const svc = makeServices(db, [makeHandle("h-noref")], (id) => {
      teardownCalls.push(id);
      return Promise.resolve();
    });

    const result = await runWorktreeGcTick(
      {
        services: svc,
        gracePeriodMs: GRACE_MS,
        branchLandedCheck: () => Promise.resolve("missing"),
      },
      NOW_FN,
    );

    expect(result.removed).toEqual(["h-noref"]);
    expect(result.unlanded_skipped).toEqual([]);
    expect(teardownCalls).toEqual(["h-noref"]);
  });

  test("F21: no worktree.gc event is emitted when teardown reports worktreeRemoved=false", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-noop", "completed", resolvedAt);

    const teardownCalls: string[] = [];
    const svc = makeServices(db, [makeHandle("h-noop")], (id) => {
      teardownCalls.push(id);
      // Simulate a concurrent sweep / already-gone handle: nothing was removed.
      return Promise.resolve({ worktreeRemoved: false, branchDeleted: false });
    });

    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

    expect(teardownCalls).toEqual(["h-noop"]);
    expect(result.removed).toEqual([]);
    const row = db
      .query<
        { kind: string },
        [string]
      >(`SELECT kind FROM dispatch_events WHERE handoff_id = ? AND kind = 'worktree.gc'`)
      .get("h-noop");
    expect(row).toBeNull();
  });

  test("F1+F2: branch SHA from teardown is recorded in worktree.gc dispatch event meta", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-sha", "completed", resolvedAt);

    const svc = makeServices(db, [makeHandle("h-sha")], () =>
      Promise.resolve({
        worktreeRemoved: true,
        branchDeleted: true,
        branchSha: "deadbeefcafebabedeadbeefcafebabedeadbeef",
      }),
    );

    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

    expect(result.removed).toEqual(["h-sha"]);
    const row = db
      .query<
        { meta_json: string },
        [string]
      >(`SELECT meta_json FROM dispatch_events WHERE handoff_id = ? AND kind = 'worktree.gc'`)
      .get("h-sha");
    const meta = JSON.parse(row?.meta_json ?? "{}") as Record<string, unknown>;
    expect(meta.branch_sha).toBe("deadbeefcafebabedeadbeefcafebabedeadbeef");
    expect(meta.branch_deleted).toBe(true);
  });

  test("branchLandedCheck error result is treated as unlanded (fail-safe defer)", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-probe-err", "completed", resolvedAt);

    const teardownCalls: string[] = [];
    const svc = makeServices(db, [makeHandle("h-probe-err")], (id) => {
      teardownCalls.push(id);
      return Promise.resolve();
    });

    const result = await runWorktreeGcTick(
      {
        services: svc,
        gracePeriodMs: GRACE_MS,
        branchLandedCheck: () => Promise.resolve("error"),
      },
      NOW_FN,
    );

    expect(result.removed).toEqual([]);
    expect(result.deferred).toEqual(["h-probe-err"]);
    expect(result.unlanded_skipped).toEqual(["h-probe-err"]);
    expect(teardownCalls).toEqual([]);

    const row = db
      .query<{ meta_json: string }, [string]>(
        `SELECT meta_json FROM dispatch_events
         WHERE handoff_id = ? AND kind = 'worktree.gc.unlanded_skipped'`,
      )
      .get("h-probe-err");
    expect(row).toBeDefined();
    const meta = JSON.parse(row?.meta_json ?? "{}") as Record<string, unknown>;
    expect(meta.land_status).toBe("error");
  });
});
