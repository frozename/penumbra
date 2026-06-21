import { loadSqliteVec, migrate, type WorktreeHandle } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PendingHandoffsError, runWorktreeGc } from "../../src/commands/worktree-gc.js";
import { expectAsyncThrow } from "./_helpers.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* sqlite already loaded */
}

let storageRoot = "";

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "penumbra-gc-cli-"));
  const db = new Database(join(storageRoot, "db.sqlite"));
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.close();
});

afterEach(() => {
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
});

function seedHandoff(
  storageRootArg: string,
  handoff_id: string,
  status: string,
  resolved_at: string | null,
): void {
  const db = new Database(join(storageRootArg, "db.sqlite"));
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
       to_role, message, status, resolved_at, use_worktree, chain_task_type
     ) VALUES (?, '2026-05-01T00:00:00.000Z', NULL, ?, 'maestro', 'worker',
               NULL, 'do work', ?, ?, 1, 'implement_small')`,
    [handoff_id, `c-${handoff_id}`, status, resolved_at],
  );
  db.close();
}

function updateHandoffStatus(
  storageRootArg: string,
  handoff_id: string,
  status: string,
  resolved_at: string | null,
): void {
  const db = new Database(join(storageRootArg, "db.sqlite"));
  db.run(
    `UPDATE handoffs
        SET status = ?, resolved_at = ?
      WHERE handoff_id = ?`,
    [status, resolved_at, handoff_id],
  );
  db.close();
}

function makeHandle(handoffId: string): WorktreeHandle {
  return {
    handoffId,
    path: `/tmp/test-worktrees/${handoffId}`,
    branchName: `agent/${handoffId}`,
    storageRoot: `/tmp/test-worktrees/${handoffId}/.test-storage`,
    createdAt: "2026-05-01T00:00:00.000Z",
    status: "created",
    worktreeMode: "symlink_mirror",
  };
}

function makeOrphan(handoffId: string): { path: string; handoffId: string } {
  const orphanPath = join(storageRoot, "worktrees", handoffId);
  mkdirSync(orphanPath, { recursive: true });
  return { path: orphanPath, handoffId };
}

const GRACE_MS = 2 * 60 * 60_000;
const OLD_RESOLVED = new Date(Date.now() - 3 * 60 * 60_000).toISOString();

interface WorktreeManagerMock {
  listWorktrees: () => WorktreeHandle[];
  teardownWorktree: (id: string) => Promise<void>;
  discoverOrphanWorktrees?: () => Promise<{ path: string; handoffId: string }[]>;
}

describe("runWorktreeGc", () => {
  test("dry-run returns candidates and does NOT call teardownWorktree", async () => {
    seedHandoff(storageRoot, "h-dry", "completed", OLD_RESOLVED);

    const teardownCalls: string[] = [];
    const wm: WorktreeManagerMock = {
      listWorktrees: (): WorktreeHandle[] => [makeHandle("h-dry")],
      teardownWorktree: (id: string): Promise<void> => {
        teardownCalls.push(id);
        return Promise.resolve();
      },
    };

    const result = await runWorktreeGc({
      storageRoot,
      apply: false,
      gracePeriodMs: GRACE_MS,
      worktreeManager: wm,
    });

    expect(result.dry_run).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.handoff_id).toBe("h-dry");
    expect(result.n_removed).toBe(0);
    expect(teardownCalls).toEqual([]);
  });

  test("--apply calls teardownWorktree for each eligible candidate", async () => {
    seedHandoff(storageRoot, "h-apply-1", "completed", OLD_RESOLVED);
    seedHandoff(storageRoot, "h-apply-2", "failed", OLD_RESOLVED);

    const teardownCalls: string[] = [];
    const wm: WorktreeManagerMock = {
      listWorktrees: (): WorktreeHandle[] => [makeHandle("h-apply-1"), makeHandle("h-apply-2")],
      teardownWorktree: (id: string): Promise<void> => {
        teardownCalls.push(id);
        return Promise.resolve();
      },
    };

    const result = await runWorktreeGc({
      storageRoot,
      apply: true,
      gracePeriodMs: GRACE_MS,
      worktreeManager: wm,
    });

    expect(result.dry_run).toBe(false);
    expect(result.n_removed).toBe(2);
    expect(result.n_failed).toBe(0);
    expect(teardownCalls.sort()).toEqual(["h-apply-1", "h-apply-2"].sort());
  });

  test("skips a candidate that becomes active again before teardown", async () => {
    seedHandoff(storageRoot, "h-race-old", "completed", OLD_RESOLVED);
    seedHandoff(storageRoot, "h-race-live", "completed", OLD_RESOLVED);

    const teardownCalls: string[] = [];
    const wm: WorktreeManagerMock = {
      listWorktrees: (): WorktreeHandle[] => [makeHandle("h-race-old"), makeHandle("h-race-live")],
      teardownWorktree: (id: string): Promise<void> => {
        teardownCalls.push(id);
        if (id === "h-race-old") {
          updateHandoffStatus(storageRoot, "h-race-live", "dispatched", null);
        }
        return Promise.resolve();
      },
    };

    const result = await runWorktreeGc({
      storageRoot,
      apply: true,
      gracePeriodMs: GRACE_MS,
      worktreeManager: wm,
    });

    expect(result.n_removed).toBe(1);
    expect(result.n_failed).toBe(0);
    expect(teardownCalls).toEqual(["h-race-old"]);
  });

  test("pending handoffs cause both dry-run and apply to throw PendingHandoffsError", async () => {
    seedHandoff(storageRoot, "h-inflight", "dispatched", null);
    seedHandoff(storageRoot, "h-old", "completed", OLD_RESOLVED);

    const teardownCalls: string[] = [];
    const wm: WorktreeManagerMock = {
      listWorktrees: (): WorktreeHandle[] => [makeHandle("h-old")],
      teardownWorktree: (id: string): Promise<void> => {
        teardownCalls.push(id);
        return Promise.resolve();
      },
    };

    for (const apply of [false, true]) {
      await expectAsyncThrow(
        runWorktreeGc({ storageRoot, apply, gracePeriodMs: GRACE_MS, worktreeManager: wm }),
        PendingHandoffsError,
      );
    }

    expect(teardownCalls).toEqual([]);
  });

  test("includes discovered orphan worktrees for old terminal handoffs", async () => {
    seedHandoff(storageRoot, "h-orphan-old", "completed", OLD_RESOLVED);
    seedHandoff(storageRoot, "h-orphan-new", "completed", new Date().toISOString());

    const teardownCalls: string[] = [];
    const wm: WorktreeManagerMock = {
      listWorktrees: (): WorktreeHandle[] => [],
      discoverOrphanWorktrees: (): Promise<{ path: string; handoffId: string }[]> =>
        Promise.resolve([makeOrphan("h-orphan-old"), makeOrphan("h-orphan-new")]),
      teardownWorktree: (id: string): Promise<void> => {
        teardownCalls.push(id);
        return Promise.resolve();
      },
    };

    const result = await runWorktreeGc({
      storageRoot,
      apply: true,
      gracePeriodMs: GRACE_MS,
      worktreeManager: wm,
    });

    expect(result.candidates.map((candidate) => candidate.handoff_id)).toEqual(["h-orphan-old"]);
    expect(result.n_removed).toBe(1);
    expect(teardownCalls).toEqual(["h-orphan-old"]);
  });

  test("closes the db handle when enumeration throws mid-run", async () => {
    seedHandoff(storageRoot, "h-throw", "completed", OLD_RESOLVED);

    type CloseFn = (this: Database, throwOnError?: boolean) => void;
    const protoSlot = Database.prototype as unknown as { close: CloseFn };
    const originalClose: CloseFn = protoSlot.close;
    let closeCount = 0;
    protoSlot.close = function (this: Database, throwOnError?: boolean): void {
      closeCount++;
      originalClose.call(this, throwOnError);
    };

    try {
      const wm: WorktreeManagerMock = {
        listWorktrees: (): WorktreeHandle[] => {
          throw new Error("boom");
        },
        teardownWorktree: (): Promise<void> => Promise.resolve(),
      };

      await expectAsyncThrow(
        runWorktreeGc({
          storageRoot,
          apply: false,
          gracePeriodMs: GRACE_MS,
          worktreeManager: wm,
        }),
        "boom",
      );

      expect(closeCount).toBeGreaterThanOrEqual(1);
    } finally {
      protoSlot.close = originalClose;
    }
  });

  test("reaps old missing-handoff orphans and skips known non-terminal orphans", async () => {
    seedHandoff(storageRoot, "h-orphan-active", "redirected", OLD_RESOLVED);
    const missing = makeOrphan("h-orphan-missing");
    const oldTime = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(missing.path, oldTime, oldTime);

    const teardownCalls: string[] = [];
    const wm: WorktreeManagerMock = {
      listWorktrees: (): WorktreeHandle[] => [],
      discoverOrphanWorktrees: (): Promise<{ path: string; handoffId: string }[]> =>
        Promise.resolve([missing, makeOrphan("h-orphan-active")]),
      teardownWorktree: (id: string): Promise<void> => {
        teardownCalls.push(id);
        return Promise.resolve();
      },
    };

    const result = await runWorktreeGc({
      storageRoot,
      apply: true,
      gracePeriodMs: GRACE_MS,
      worktreeManager: wm,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.handoff_id).toBe("h-orphan-missing");
    expect(result.candidates[0]?.reason).toBe("missing_handoff_orphan");
    expect(result.n_removed).toBe(1);
    expect(teardownCalls).toEqual(["h-orphan-missing"]);
  });
});
