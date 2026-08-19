import {
  DispatchEventLog,
  HandoffReader,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  type Services,
  type WorktreeHandle,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { lifecycleLock, resetLifecycleLock } from "../../src/dispatch/lifecycle-lock.js";
import { type BranchLandStatus, runWorktreeGcTick } from "../../src/sweepers/worktree-gc.js";

const execFile = promisify(execFileCb);

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
    dispatchEventLog: new DispatchEventLog(db),
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

function insertHandoffWithBranchBase(
  db: Database,
  handoff_id: string,
  status: string,
  resolved_at: string | null,
  branch_base: string,
): void {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
       to_role, message, status, resolved_at, use_worktree, chain_task_type,
       branch_base
     ) VALUES (?, '2026-05-01T00:00:00.000Z', NULL, ?, 'maestro', 'worker',
               NULL, 'do work', ?, ?, 1, 'implement_small', ?)`,
    [handoff_id, `c-${handoff_id}`, status, resolved_at, branch_base],
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

function listUnlandedSkippedEvents(db: Database): { handoff_id: string; meta_json: string }[] {
  return db
    .query<{ handoff_id: string; meta_json: string }, []>(
      `SELECT handoff_id, meta_json FROM dispatch_events
       WHERE kind = 'worktree.gc.unlanded_skipped'
       ORDER BY id ASC`,
    )
    .all();
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

  test("unlanded branches are deferred, emit one summarized worktree.gc.unlanded_skipped event, and are NOT removed", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    for (const id of ["h-unlanded-a", "h-unlanded-b", "h-unlanded-c"]) {
      insertHandoff(db, id, "completed", resolvedAt);
    }

    const teardownCalls: string[] = [];
    const probedBranches: string[] = [];
    const svc = makeServices(
      db,
      [makeHandle("h-unlanded-a"), makeHandle("h-unlanded-b"), makeHandle("h-unlanded-c")],
      (id) => {
        teardownCalls.push(id);
        return Promise.resolve();
      },
    );

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

    expect(probedBranches).toEqual([
      "agent/h-unlanded-a",
      "agent/h-unlanded-b",
      "agent/h-unlanded-c",
    ]);
    expect(result.candidates).toEqual(["h-unlanded-a", "h-unlanded-b", "h-unlanded-c"]);
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.deferred).toEqual(["h-unlanded-a", "h-unlanded-b", "h-unlanded-c"]);
    expect(result.unlanded_skipped).toEqual(["h-unlanded-a", "h-unlanded-b", "h-unlanded-c"]);
    expect(teardownCalls).toEqual([]);

    const rows = listUnlandedSkippedEvents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.handoff_id).toBe("h-unlanded-a");

    const meta = JSON.parse(rows[0]?.meta_json ?? "{}") as Record<string, unknown>;
    expect(meta).toEqual({
      count: 3,
      handoff_ids: ["h-unlanded-a", "h-unlanded-b", "h-unlanded-c"],
      truncated: false,
    });

    // No worktree.gc event for the unlanded candidate.
    const reapRow = db
      .query<
        { kind: string },
        [string]
      >(`SELECT kind FROM dispatch_events WHERE handoff_id = ? AND kind = 'worktree.gc'`)
      .get("h-unlanded-a");
    expect(reapRow).toBeNull();
  });

  test("identical unlanded skipped set is not emitted again until membership changes", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    const handles = [makeHandle("h-skip-a"), makeHandle("h-skip-b"), makeHandle("h-skip-c")];
    for (const handle of handles) insertHandoff(db, handle.handoffId, "completed", resolvedAt);

    const debugLogs: unknown[] = [];
    const landed = new Set<string>();
    const svc = makeServices(db, handles, () =>
      Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
    );
    const branchLandedCheck = (branch: string): Promise<BranchLandStatus> => {
      const handoffId = branch.slice("agent/".length);
      return Promise.resolve(landed.has(handoffId) ? "landed" : "unlanded");
    };

    const first = await runWorktreeGcTick(
      {
        services: svc,
        gracePeriodMs: GRACE_MS,
        branchLandedCheck,
        log: { debug: (obj: unknown): number => debugLogs.push(obj) },
      },
      NOW_FN,
    );
    expect(first.unlanded_skipped).toEqual(["h-skip-a", "h-skip-b", "h-skip-c"]);
    expect(listUnlandedSkippedEvents(db)).toHaveLength(1);
    expect(debugLogs).toEqual([]);

    const second = await runWorktreeGcTick(
      {
        services: svc,
        gracePeriodMs: GRACE_MS,
        branchLandedCheck,
        log: { debug: (obj: unknown): number => debugLogs.push(obj) },
      },
      NOW_FN,
    );
    expect(second.unlanded_skipped).toEqual(["h-skip-a", "h-skip-b", "h-skip-c"]);
    expect(listUnlandedSkippedEvents(db)).toHaveLength(1);
    expect(debugLogs).toHaveLength(1);

    landed.add("h-skip-a");
    const third = await runWorktreeGcTick(
      {
        services: svc,
        gracePeriodMs: GRACE_MS,
        branchLandedCheck,
        log: { debug: (obj: unknown): number => debugLogs.push(obj) },
      },
      NOW_FN,
    );
    expect(third.unlanded_skipped).toEqual(["h-skip-b", "h-skip-c"]);
    expect(debugLogs).toHaveLength(1);

    const rows = listUnlandedSkippedEvents(db);
    expect(rows).toHaveLength(2);
    const meta = JSON.parse(rows[1]?.meta_json ?? "{}") as Record<string, unknown>;
    expect(meta).toEqual({
      count: 2,
      handoff_ids: ["h-skip-b", "h-skip-c"],
      truncated: false,
    });
  });

  test("unlanded skipped summary caps handoff_ids at 20 and stays below dispatch_events meta limit", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    const ids = Array.from(
      { length: 200 },
      (_, i) => `h-${String(i).padStart(3, "0")}-${"x".repeat(180)}`,
    );
    for (const id of ids) insertHandoff(db, id, "completed", resolvedAt);

    const svc = makeServices(
      db,
      ids.map((id) => makeHandle(id)),
      () => Promise.resolve(),
    );

    const result = await runWorktreeGcTick(
      {
        services: svc,
        gracePeriodMs: GRACE_MS,
        branchLandedCheck: () => Promise.resolve("unlanded"),
      },
      NOW_FN,
    );

    expect(result.unlanded_skipped).toEqual(ids);
    const rows = listUnlandedSkippedEvents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta_json.length).toBeLessThanOrEqual(4096);
    const meta = JSON.parse(rows[0]?.meta_json ?? "{}") as {
      count?: unknown;
      handoff_ids?: unknown;
      truncated?: unknown;
      _truncated?: unknown;
    };
    expect(meta._truncated).toBeUndefined();
    expect(meta.count).toBe(200);
    expect(meta.truncated).toBe(true);
    expect(meta.handoff_ids).toEqual(ids.slice(0, 20));
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

  test("returns empty stage_reaped/stage_deferred when no stage/* refs exist", async () => {
    const db = setupDb();
    const svc = makeServices(db, [], () => Promise.resolve());
    // Point at a directory that isn't a git repo so for-each-ref fails; the
    // stage reaper must fail-closed to empty (no throw, no fabricated ref).
    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );
    expect(result.stage_reaped).toEqual([]);
    expect(result.stage_deferred).toEqual([]);
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
    expect(meta).toEqual({
      count: 1,
      handoff_ids: ["h-probe-err"],
      truncated: false,
    });
  });
});

function makeServicesWithRepo(
  db: Database,
  mainRepoDir: string,
  worktreeHandles: WorktreeHandle[] = [],
): Services {
  return {
    db,
    dispatchEventLog: new DispatchEventLog(db),
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
      discoverOrphanWorktrees: () => Promise.resolve([]),
      teardownWorktree: () => Promise.resolve({ worktreeRemoved: true, branchDeleted: true }),
      mainRepoDir,
    },
  } as unknown as Services;
}

async function stageRefExists(repoDir: string, ref: string): Promise<boolean> {
  try {
    await execFile("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${ref}`]);
    return true;
  } catch {
    return false;
  }
}

describe("runWorktreeGcTick — stage/* branch reaper", () => {
  let repoDir: string;
  let baseSha: string;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-stage-gc-"));
    await execFile("git", ["-C", repoDir, "init", "-b", "main"]);
    await execFile("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", repoDir, "config", "user.name", "test"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# base\n");
    await execFile("git", ["-C", repoDir, "add", "README.md"]);
    await execFile("git", ["-C", repoDir, "commit", "-m", "base"]);
    const { stdout } = await execFile("git", ["-C", repoDir, "rev-parse", "HEAD"]);
    baseSha = stdout.trim();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test("stage/* branch WITHOUT any referencing handoff is preserved (fail-closed)", async () => {
    const db = setupDb();
    await execFile("git", ["-C", repoDir, "branch", "stage/orphaned", baseSha]);
    const svc = makeServicesWithRepo(db, repoDir);

    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

    expect(result.stage_reaped).toEqual([]);
    expect(result.stage_deferred).toContain("stage/orphaned");
    expect(await stageRefExists(repoDir, "stage/orphaned")).toBe(true);
  });

  test("stage/* branch is reaped when every referencing handoff is terminal + past grace", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoffWithBranchBase(db, "h-stage-done", "completed", resolvedAt, "stage/reaped");
    await execFile("git", ["-C", repoDir, "branch", "stage/reaped", baseSha]);

    const svc = makeServicesWithRepo(db, repoDir);
    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

    expect(result.stage_reaped).toEqual(["stage/reaped"]);
    expect(result.stage_deferred).not.toContain("stage/reaped");
    expect(await stageRefExists(repoDir, "stage/reaped")).toBe(false);

    const eventRow = db
      .query<{ kind: string; meta_json: string }, [string]>(
        `SELECT kind, meta_json FROM dispatch_events
         WHERE handoff_id = ? AND kind = 'worktree.gc.stage_reaped'`,
      )
      .get("reaped");
    expect(eventRow).toBeDefined();
    const meta = JSON.parse(eventRow?.meta_json ?? "{}") as Record<string, unknown>;
    expect(meta.ref).toBe("stage/reaped");
    expect(meta.referencing_handoffs).toBe(1);
  });

  test("stage/* branch is deferred when a referencing handoff is non-terminal", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoffWithBranchBase(db, "h-done", "completed", resolvedAt, "stage/mixed");
    insertHandoffWithBranchBase(db, "h-live", "dispatched", null, "stage/mixed");
    await execFile("git", ["-C", repoDir, "branch", "stage/mixed", baseSha]);

    const svc = makeServicesWithRepo(db, repoDir);
    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

    expect(result.stage_reaped).toEqual([]);
    expect(result.stage_deferred).toContain("stage/mixed");
    expect(await stageRefExists(repoDir, "stage/mixed")).toBe(true);
  });

  test("stage/* branch is deferred when a referencing handoff is terminal but WITHIN grace", async () => {
    const db = setupDb();
    // resolved 1h ago — within 2h grace
    const resolvedAt = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    insertHandoffWithBranchBase(db, "h-recent", "completed", resolvedAt, "stage/recent");
    await execFile("git", ["-C", repoDir, "branch", "stage/recent", baseSha]);

    const svc = makeServicesWithRepo(db, repoDir);
    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

    expect(result.stage_reaped).toEqual([]);
    expect(result.stage_deferred).toContain("stage/recent");
    expect(await stageRefExists(repoDir, "stage/recent")).toBe(true);
  });

  test("non-stage branches (agent/*, main) are ignored by the stage reaper", async () => {
    const db = setupDb();
    // agent/foo has no referencing handoff row; still must not be reaped by the stage sweep.
    await execFile("git", ["-C", repoDir, "branch", "agent/keep-me", baseSha]);

    const svc = makeServicesWithRepo(db, repoDir);
    const result = await runWorktreeGcTick(
      { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
      NOW_FN,
    );

    expect(result.stage_reaped).toEqual([]);
    expect(result.stage_deferred).toEqual([]);
    expect(await stageRefExists(repoDir, "agent/keep-me")).toBe(true);
    expect(await stageRefExists(repoDir, "main")).toBe(true);
  });

  test("stage/* reaper is skipped when lifecycle lock is held", async () => {
    resetLifecycleLock();
    const release = await lifecycleLock.acquire("h-landing");
    try {
      const db = setupDb();
      const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
      insertHandoffWithBranchBase(db, "h-stage-done", "completed", resolvedAt, "stage/locked");
      await execFile("git", ["-C", repoDir, "branch", "stage/locked", baseSha]);

      const svc = makeServicesWithRepo(db, repoDir);
      const result = await runWorktreeGcTick(
        { services: svc, gracePeriodMs: GRACE_MS, branchLandedCheck: ALWAYS_LANDED },
        NOW_FN,
      );

      expect(result.stage_reaped).toEqual([]);
      expect(result.stage_deferred).toEqual([]);
      expect(await stageRefExists(repoDir, "stage/locked")).toBe(true);
    } finally {
      release();
      resetLifecycleLock();
    }
  });
});

describe("runWorktreeGcTick — default git-backed branchLandedCheck", () => {
  let repoDir: string;
  let baseSha: string;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-landed-gc-"));
    await execFile("git", ["-C", repoDir, "init", "-b", "main"]);
    await execFile("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", repoDir, "config", "user.name", "test"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# base\n");
    await execFile("git", ["-C", repoDir, "add", "README.md"]);
    await execFile("git", ["-C", repoDir, "commit", "-m", "base"]);
    const { stdout } = await execFile("git", ["-C", repoDir, "rev-parse", "HEAD"]);
    baseSha = stdout.trim();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  // (a) A squash-landed branch: its own commit is NOT an ancestor of main, but
  // its content is fully present in main (dispatch_land squashes). Must classify
  // as "landed" and be reaped — this is the defect the fix targets.
  test("squash-landed branch (non-ancestor, content in main) IS reaped", async () => {
    const db = setupDb();
    // Branch introduces feature.txt + edits README.
    await execFile("git", ["-C", repoDir, "checkout", "-b", "agent/h-squash", baseSha]);
    fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# base\nfeature\n");
    await execFile("git", ["-C", repoDir, "add", "-A"]);
    await execFile("git", ["-C", repoDir, "commit", "-m", "add feature"]);
    // Squash-land the SAME content onto main as a fresh commit, then move on.
    await execFile("git", ["-C", repoDir, "checkout", "main"]);
    fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# base\nfeature\n");
    await execFile("git", ["-C", repoDir, "add", "-A"]);
    await execFile("git", ["-C", repoDir, "commit", "-m", "land feature (squash)"]);
    fs.writeFileSync(path.join(repoDir, "next.txt"), "next\n");
    await execFile("git", ["-C", repoDir, "add", "-A"]);
    await execFile("git", ["-C", repoDir, "commit", "-m", "later unrelated work"]);

    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-squash", "completed", resolvedAt);
    const svc = makeServicesWithRepo(db, repoDir, [makeHandle("h-squash")]);

    const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

    expect(result.removed).toEqual(["h-squash"]);
    expect(result.unlanded_skipped).toEqual([]);
    expect(result.deferred).toEqual([]);
    const row = db
      .query<
        { meta_json: string },
        [string]
      >(`SELECT meta_json FROM dispatch_events WHERE handoff_id = ? AND kind = 'worktree.gc'`)
      .get("h-squash");
    const meta = JSON.parse(row?.meta_json ?? "{}") as Record<string, unknown>;
    expect(meta.land_status).toBe("landed");
  });

  // (a') Fast path: a branch that IS an ancestor of main is still "landed".
  test("ancestor branch IS reaped (classified landed)", async () => {
    const db = setupDb();
    await execFile("git", ["-C", repoDir, "branch", "agent/h-anc", baseSha]);
    fs.writeFileSync(path.join(repoDir, "more.txt"), "more\n");
    await execFile("git", ["-C", repoDir, "add", "-A"]);
    await execFile("git", ["-C", repoDir, "commit", "-m", "advance main past branch"]);

    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-anc", "completed", resolvedAt);
    const svc = makeServicesWithRepo(db, repoDir, [makeHandle("h-anc")]);

    const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

    expect(result.removed).toEqual(["h-anc"]);
    expect(result.unlanded_skipped).toEqual([]);
  });

  // (b) A branch with genuine content not present in main must stay "unlanded"
  // and be preserved — reaping would lose work (regression guard).
  test("genuinely unlanded branch (real content not in main) is PRESERVED", async () => {
    const db = setupDb();
    await execFile("git", ["-C", repoDir, "checkout", "-b", "agent/h-real", baseSha]);
    fs.writeFileSync(path.join(repoDir, "unmerged.txt"), "real unmerged work\n");
    await execFile("git", ["-C", repoDir, "add", "-A"]);
    await execFile("git", ["-C", repoDir, "commit", "-m", "real work"]);
    await execFile("git", ["-C", repoDir, "checkout", "main"]);
    // main advances independently; the branch's file never lands.
    fs.writeFileSync(path.join(repoDir, "other.txt"), "other\n");
    await execFile("git", ["-C", repoDir, "add", "-A"]);
    await execFile("git", ["-C", repoDir, "commit", "-m", "unrelated main work"]);

    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-real", "completed", resolvedAt);
    const svc = makeServicesWithRepo(db, repoDir, [makeHandle("h-real")]);

    const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

    expect(result.removed).toEqual([]);
    expect(result.unlanded_skipped).toEqual(["h-real"]);
    const row = db
      .query<{ meta_json: string }, [string]>(
        `SELECT meta_json FROM dispatch_events
         WHERE handoff_id = ? AND kind = 'worktree.gc.unlanded_skipped'`,
      )
      .get("h-real");
    const meta = JSON.parse(row?.meta_json ?? "{}") as Record<string, unknown>;
    expect(meta).toEqual({
      count: 1,
      handoff_ids: ["h-real"],
      truncated: false,
    });
  });

  // (c) A missing branch ref classifies "missing" and is reaped (nothing to lose).
  test("missing branch ref classifies missing and IS reaped", async () => {
    const db = setupDb();
    // No agent/h-gone branch is ever created.
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-gone", "completed", resolvedAt);
    const svc = makeServicesWithRepo(db, repoDir, [makeHandle("h-gone")]);

    const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

    expect(result.removed).toEqual(["h-gone"]);
    expect(result.unlanded_skipped).toEqual([]);
  });

  // (d) A probe error (mainRepoDir is not a git repo) fails safe: defer, never reap.
  test("probe error (non-git mainRepoDir) fails safe and defers", async () => {
    const db = setupDb();
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-nonrepo-"));
    try {
      const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
      insertHandoff(db, "h-err", "completed", resolvedAt);
      const svc = makeServicesWithRepo(db, nonRepo, [makeHandle("h-err")]);

      const result = await runWorktreeGcTick({ services: svc, gracePeriodMs: GRACE_MS }, NOW_FN);

      expect(result.removed).toEqual([]);
      expect(result.unlanded_skipped).toEqual(["h-err"]);
      const row = db
        .query<{ meta_json: string }, [string]>(
          `SELECT meta_json FROM dispatch_events
           WHERE handoff_id = ? AND kind = 'worktree.gc.unlanded_skipped'`,
        )
        .get("h-err");
      const meta = JSON.parse(row?.meta_json ?? "{}") as Record<string, unknown>;
      expect(meta).toEqual({
        count: 1,
        handoff_ids: ["h-err"],
        truncated: false,
      });
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
