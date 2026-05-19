import type { Services } from '@penumbra/core';

export interface WorktreeGcOpts {
  services: Services;
  /** How old (ms) a terminal worktree must be before GC. Default 2h. */
  gracePeriodMs?: number;
  log?: { warn?: (obj: unknown, msg?: string) => void };
}

export interface WorktreeGcTickResult {
  candidates: string[];
  removed: string[];
  failed: string[];
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'rejected', 'expired']);
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
  const candidates: string[] = [];
  const removed: string[] = [];
  const failed: string[] = [];

  for (const handle of handles) {
    const handoff = services.handoffReader.get(handle.handoffId);

    // Skip if no DB record (orphan on disk — defer to manual GC)
    if (!handoff) continue;

    // Skip non-terminal handoffs (in-flight guard)
    if (!TERMINAL_STATUSES.has(handoff.status)) continue;

    // Skip if resolved too recently (within grace period)
    const resolvedAt = handoff.resolved_at ? new Date(handoff.resolved_at).getTime() : null;
    if (resolvedAt === null || nowMs - resolvedAt < gracePeriodMs) continue;

    candidates.push(handle.handoffId);

    try {
      await services.worktreeManager.teardownWorktree(handle.handoffId, /*force=*/true);

      const ts = now().toISOString();
      services.db
        .query<unknown, [string, string, string]>(
          `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
           VALUES (?, NULL, 'sweeper', 'worktree.gc', ?, ?)`,
        )
        .run(
          handle.handoffId,
          ts,
          JSON.stringify({
            handoff_id: handle.handoffId,
            branch_name: handle.branchName,
            status: handoff.status,
            age_ms: nowMs - resolvedAt,
          }),
        );

      removed.push(handle.handoffId);
    } catch (err) {
      opts.log?.warn?.(
        { handoff_id: handle.handoffId, err: String(err) },
        'worktree-gc teardown failed; skipping',
      );
      failed.push(handle.handoffId);
    }
  }

  return { candidates, removed, failed };
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
    runWorktreeGcTick(effectiveOpts, now).catch((err) => {
      opts.log?.warn?.({ err: String(err) }, 'worktree-gc sweep failed');
    });
  }, intervalMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  return () => clearInterval(timer);
}
