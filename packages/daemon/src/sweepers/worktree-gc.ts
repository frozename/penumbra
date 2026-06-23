import { selectWorktreeGcCandidates, type Services } from "@penumbra/core";

import { lifecycleLock } from "../dispatch/lifecycle-lock.js";

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

export interface WorktreeGcOpts {
  services: Services;
  /** How old (ms) a terminal worktree must be before GC. Default 2h. */
  gracePeriodMs?: number;
  log?: {
    warn?: (obj: unknown, msg?: string) => void;
    debug?: (obj: unknown, msg?: string) => void;
  };
}

export interface WorktreeGcTickResult {
  candidates: string[];
  removed: string[];
  failed: string[];
  deferred: string[];
}

const DEFAULT_GRACE_PERIOD_MS = 2 * 60 * 60_000;

/**
 * One GC tick: remove worktrees whose handoff is terminal and resolved
 * more than gracePeriodMs ago. Emits a worktree.gc dispatch event per removal.
 * Idempotent and failure-tolerant — failures are logged and skipped.
 */
export async function runWorktreeGcTick(
  opts: WorktreeGcOpts,
  now: () => Date = () => new Date(),
): Promise<WorktreeGcTickResult> {
  const { services } = opts;
  const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const nowMs = now().getTime();

  const handles = services.worktreeManager.listWorktrees();
  const orphanHandles = await services.worktreeManager.discoverOrphanWorktrees();
  const gcCandidates = selectWorktreeGcCandidates({
    trackedHandles: handles,
    orphanHandles,
    handoffReader: services.handoffReader,
    gracePeriodMs,
    nowMs,
  });
  const candidates = gcCandidates.map((candidate) => candidate.handoff_id);
  const removed: string[] = [];
  const failed: string[] = [];
  const deferred: string[] = [];

  for (const candidate of gcCandidates) {
    try {
      if (lifecycleLock.isHeld()) {
        deferred.push(candidate.handoff_id);
        opts.log?.debug?.(
          { handoff_id: candidate.handoff_id },
          "worktree-gc teardown deferred while lifecycle lock is held",
        );
        continue;
      }

      await services.worktreeManager.teardownWorktree(candidate.handoff_id, /*force=*/ true);

      const ts = now().toISOString();
      services.db
        .query<unknown, [string, string, string]>(
          `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
           VALUES (?, NULL, 'sweeper', 'worktree.gc', ?, ?)`,
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

      removed.push(candidate.handoff_id);
    } catch (err) {
      opts.log?.warn?.(
        { handoff_id: candidate.handoff_id, err: String(err) },
        "worktree-gc teardown failed; skipping",
      );
      failed.push(candidate.handoff_id);
    }
  }

  return { candidates, removed, failed, deferred };
}

/** Schedules the GC sweep on a recurring interval. Returns a cancel function. */
export function startWorktreeGcSweeper(
  opts: WorktreeGcOpts,
  intervalMs: number = Number(process.env.PENUMBRA_WORKTREE_GC_INTERVAL_MS) || 30 * 60_000,
  now: () => Date = () => new Date(),
): () => void {
  const gracePeriodMs =
    opts.gracePeriodMs ??
    (process.env.PENUMBRA_WORKTREE_GC_GRACE_MS
      ? Number(process.env.PENUMBRA_WORKTREE_GC_GRACE_MS)
      : DEFAULT_GRACE_PERIOD_MS);

  const effectiveOpts = { ...opts, gracePeriodMs };

  const timer = setInterval(() => {
    runWorktreeGcTick(effectiveOpts, now).catch((err: unknown) => {
      opts.log?.warn?.({ err: String(err) }, "worktree-gc sweep failed");
    });
  }, intervalMs);
  maybeUnref(timer);
  return () => {
    clearInterval(timer);
  };
}
