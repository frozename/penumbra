import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { HandoffReader, WorktreeManager, loadSqliteVec, type WorktreeHandle } from "@penumbra/core";
import { resolveStorageDbPath } from "../../../core/src/db/storage-db-path.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

const TERMINAL_STATUSES = new Set(["completed", "failed", "rejected", "expired"]);
const DEFAULT_GRACE_MS = 2 * 60 * 60_000;
type WorktreeGcManager = {
  listWorktrees(): WorktreeHandle[];
  discoverOrphanWorktrees?(): Array<{ path: string; handoffId: string }>;
  teardownWorktree(handoffId: string, force?: boolean): Promise<unknown>;
};

export interface WorktreeGcOpts {
  storageRoot: string;
  apply: boolean;
  gracePeriodMs?: number;
  /** Injectable for testing; defaults to new WorktreeManager(). */
  worktreeManager?: WorktreeGcManager;
}

export interface WorktreeGcCandidate {
  handoff_id: string;
  branch: string;
  status: string;
  resolved_at: string;
  path: string;
  age_ms: number;
  reason: "terminal_tracked" | "terminal_orphan" | "missing_handoff_orphan";
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
  loadSqliteVec(db);

  const handoffReader = new HandoffReader({ db });

  // Hard refusal: any in-flight dispatches
  const pending = handoffReader.listByStatus({ statuses: ["dispatched", "pending", "approved"] });
  if (pending.length > 0) {
    db.close();
    throw new PendingHandoffsError(pending.map((h) => h.handoff_id));
  }

  const worktreeManager: WorktreeGcManager = opts.worktreeManager ?? new WorktreeManager();
  const handles = worktreeManager.listWorktrees();

  const candidates: WorktreeGcCandidate[] = [];

  for (const handle of handles) {
    const handoff = handoffReader.get(handle.handoffId);
    if (!handoff) continue;
    if (!TERMINAL_STATUSES.has(handoff.status)) continue;

    const resolvedAt = handoff.resolved_at ? new Date(handoff.resolved_at).getTime() : null;
    if (resolvedAt === null || nowMs - resolvedAt < gracePeriodMs) continue;

    candidates.push({
      handoff_id: handle.handoffId,
      branch: handle.branchName,
      status: handoff.status,
      resolved_at: handoff.resolved_at!,
      path: handle.path,
      age_ms: nowMs - resolvedAt,
      reason: "terminal_tracked",
    });
  }

  for (const orphan of worktreeManager.discoverOrphanWorktrees?.() ?? []) {
    const handoff = handoffReader.get(orphan.handoffId);
    if (handoff) {
      if (!TERMINAL_STATUSES.has(handoff.status)) continue;

      const resolvedAt = handoff.resolved_at ? new Date(handoff.resolved_at).getTime() : null;
      if (resolvedAt === null || nowMs - resolvedAt < gracePeriodMs) continue;

      candidates.push({
        handoff_id: orphan.handoffId,
        branch: `agent/${orphan.handoffId}`,
        status: handoff.status,
        resolved_at: handoff.resolved_at!,
        path: orphan.path,
        age_ms: nowMs - resolvedAt,
        reason: "terminal_orphan",
      });
      continue;
    }

    let mtimeMs: number;
    try {
      mtimeMs = fileMtimeMs(orphan.path);
    } catch {
      continue;
    }
    if (nowMs - mtimeMs < gracePeriodMs) continue;

    candidates.push({
      handoff_id: orphan.handoffId,
      branch: `agent/${orphan.handoffId}`,
      status: "missing",
      resolved_at: new Date(mtimeMs).toISOString(),
      path: orphan.path,
      age_ms: nowMs - mtimeMs,
      reason: "missing_handoff_orphan",
    });
  }

  // Sort oldest first
  candidates.sort((a, b) => a.age_ms - b.age_ms);

  db.close();

  let n_removed = 0;
  let n_failed = 0;

  if (apply) {
    // Re-open writable for GC events
    const writableDb = new Database(resolveStorageDbPath(storageRoot));
    loadSqliteVec(writableDb);
    const gcManager: WorktreeGcManager = opts.worktreeManager ?? new WorktreeManager();

    for (const candidate of candidates) {
      try {
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

    writableDb.close();
  }

  return { candidates, n_removed, n_failed, dry_run: !apply };
}

function fileMtimeMs(targetPath: string): number {
  return statSync(targetPath).mtimeMs;
}

export class PendingHandoffsError extends Error {
  constructor(public readonly handoff_ids: string[]) {
    super(
      `in-flight handoffs detected, refusing GC; wait for them to land: ${handoff_ids.join(", ")}`,
    );
    this.name = "PendingHandoffsError";
  }
}
