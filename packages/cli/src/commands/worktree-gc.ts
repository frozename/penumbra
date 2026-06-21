import { Database } from "bun:sqlite";
import {
  HandoffReader,
  WorktreeManager,
  loadSqliteVec,
  selectWorktreeGcCandidates,
  type WorktreeGcCandidate,
  type WorktreeHandle,
} from "@penumbra/core";
import { resolveStorageDbPath } from "../../../core/src/db/storage-db-path.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

const DEFAULT_GRACE_MS = 2 * 60 * 60_000;
type MaybePromise<T> = T | Promise<T>;
type WorktreeGcManager = {
  listWorktrees(): WorktreeHandle[];
  discoverOrphanWorktrees?(): MaybePromise<Array<{ path: string; handoffId: string }>>;
  teardownWorktree(handoffId: string, force?: boolean): Promise<unknown>;
};

export interface WorktreeGcOpts {
  storageRoot: string;
  apply: boolean;
  gracePeriodMs?: number;
  /** Injectable for testing; defaults to new WorktreeManager(). */
  worktreeManager?: WorktreeGcManager;
}

export interface WorktreeGcResult {
  candidates: WorktreeGcCandidate[];
  n_removed: number;
  n_failed: number;
  dry_run: boolean;
}

export async function runWorktreeGc(opts: WorktreeGcOpts): Promise<WorktreeGcResult> {
  const { storageRoot, apply } = opts;
  const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_MS;
  const nowMs = Date.now();

  const dbPath = resolveStorageDbPath(storageRoot);
  const db = new Database(dbPath, { readonly: true });
  let candidates: WorktreeGcCandidate[];
  try {
    loadSqliteVec(db);

    const handoffReader = new HandoffReader({ db });

    // Hard refusal: any in-flight dispatches
    const pending = handoffReader.listByStatus({
      statuses: ["dispatched", "pending", "approved"],
    });
    if (pending.length > 0) {
      throw new PendingHandoffsError(pending.map((h) => h.handoff_id));
    }

    const worktreeManager: WorktreeGcManager = opts.worktreeManager ?? new WorktreeManager();
    const handles = worktreeManager.listWorktrees();
    const orphanHandles = (await worktreeManager.discoverOrphanWorktrees?.()) ?? [];

    candidates = selectWorktreeGcCandidates({
      trackedHandles: handles,
      orphanHandles,
      handoffReader,
      gracePeriodMs,
      nowMs,
    });
  } finally {
    db.close();
  }

  let n_removed = 0;
  let n_failed = 0;

  if (apply) {
    // Re-open writable for GC events
    const writableDb = new Database(resolveStorageDbPath(storageRoot));
    try {
      loadSqliteVec(writableDb);
      const gcManager: WorktreeGcManager = opts.worktreeManager ?? new WorktreeManager();
      const writableHandoffReader = new HandoffReader({ db: writableDb });

      for (const candidate of candidates) {
        try {
          const activeHandoff = writableHandoffReader
            .listByStatus({
              statuses: ["dispatched", "pending", "approved"],
            })
            .find((handoff) => handoff.handoff_id === candidate.handoff_id);

          if (activeHandoff) {
            continue;
          }

          await gcManager.teardownWorktree(candidate.handoff_id, /*force=*/ true);
          const ts = new Date().toISOString();
          writableDb
            .query<unknown, [string, string, string]>(
              `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
               VALUES (?, NULL, 'cli-gc', 'worktree.gc', ?, ?)`,
            )
            .run(
              candidate.handoff_id,
              ts,
              JSON.stringify({
                handoff_id: candidate.handoff_id,
                branch_name: candidate.branch,
                status: candidate.status,
                age_ms: candidate.age_ms,
                reason: candidate.reason,
              }),
            );
          console.log(
            `reaped worktree ${candidate.handoff_id}: ${candidate.reason} (${candidate.path})`,
          );
          n_removed++;
        } catch {
          n_failed++;
        }
      }
    } finally {
      writableDb.close();
    }
  }

  return { candidates, n_removed, n_failed, dry_run: !apply };
}

export class PendingHandoffsError extends Error {
  constructor(public readonly handoff_ids: string[]) {
    super(
      `in-flight handoffs detected, refusing GC; wait for them to land: ${handoff_ids.join(", ")}`,
    );
    this.name = "PendingHandoffsError";
  }
}
