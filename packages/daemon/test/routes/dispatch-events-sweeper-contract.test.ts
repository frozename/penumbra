// Relative import: the daemon package's node_modules symlink resolves
// @penumbra/api-contract to the shared home checkout, which lags this branch's
// enum additions ("worktree.gc.unlanded_skipped", "reconciler.sweep.tick").
// Reading the local source directly keeps the contract test honest during the
// worktree-isolated build; after landing, the "@penumbra/api-contract" import
// is a drop-in replacement.
import { DispatchEventsListResponseSchema } from "../../../api-contract/src/dispatch-events.js";
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
import { describe, expect, test } from "bun:test";

import { dispatchEventsGetRoute } from "../../src/routes/dispatch-events.js";
import { type BranchLandStatus, runWorktreeGcTick } from "../../src/sweepers/worktree-gc.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // ignore
}

const NOW = new Date("2026-05-19T10:00:00.000Z");
const NOW_FN = (): Date => NOW;
const GRACE_MS = 2 * 60 * 60_000;

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function noop(): void {
  return undefined;
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

function makeServices(db: Database, worktreeHandles: WorktreeHandle[]): Services {
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
      teardownWorktree: () =>
        Promise.resolve({
          worktreeRemoved: true,
          branchDeleted: true,
          branchSha: "deadbeef",
        }),
      mainRepoDir: "/tmp/main-repo",
    },
  } as unknown as Services;
}

describe("dispatch events sweeper contract", () => {
  test("worktree.gc.unlanded_skipped events emitted by sweeper pass DispatchEventsListResponseSchema", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-unlanded", "completed", resolvedAt);

    const svc = makeServices(db, [makeHandle("h-unlanded")]);

    await runWorktreeGcTick(
      {
        services: svc,
        gracePeriodMs: GRACE_MS,
        branchLandedCheck: (): Promise<BranchLandStatus> => Promise.resolve("unlanded"),
      },
      NOW_FN,
    );

    const row = db
      .query<
        { source: string; kind: string },
        [string]
      >(`SELECT source, kind FROM dispatch_events WHERE handoff_id = ? LIMIT 1`)
      .get("h-unlanded");
    expect(row?.source).toBe("daemon");
    expect(row?.kind).toBe("worktree.gc.unlanded_skipped");

    const res = dispatchEventsGetRoute(
      new Request("http://x/dispatch/events?handoff_id=h-unlanded"),
      svc,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const parsed = DispatchEventsListResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `DispatchEventsListResponseSchema.safeParse failed: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    expect(parsed.success).toBe(true);
  });

  test("worktree.gc events emitted by sweeper pass DispatchEventsListResponseSchema", async () => {
    const db = setupDb();
    const resolvedAt = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    insertHandoff(db, "h-landed", "completed", resolvedAt);

    const svc = makeServices(db, [makeHandle("h-landed")]);

    await runWorktreeGcTick(
      {
        services: svc,
        gracePeriodMs: GRACE_MS,
        branchLandedCheck: (): Promise<BranchLandStatus> => Promise.resolve("landed"),
      },
      NOW_FN,
    );

    const row = db
      .query<
        { source: string; kind: string },
        [string]
      >(`SELECT source, kind FROM dispatch_events WHERE handoff_id = ? LIMIT 1`)
      .get("h-landed");
    expect(row?.source).toBe("daemon");
    expect(row?.kind).toBe("worktree.gc");

    const res = dispatchEventsGetRoute(
      new Request("http://x/dispatch/events?handoff_id=h-landed"),
      svc,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const parsed = DispatchEventsListResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `DispatchEventsListResponseSchema.safeParse failed: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    expect(parsed.success).toBe(true);
  });
});
