import { selectWorktreeGcCandidates, type DispatchEventInput, type Services } from "@penumbra/core";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

// Pinned to the worktree-local manager source so the new `branchSha` field on
// teardownWorktree's return type is visible inside symlink_mirror worktrees;
// the @penumbra/core resolution chain otherwise points back to the home repo.
import type { WorktreeManager as WorktreeManagerLocal } from "../../../core/src/worktree/manager.js";

import { lifecycleLock } from "../dispatch/lifecycle-lock.js";

type TeardownResult = Awaited<ReturnType<WorktreeManagerLocal["teardownWorktree"]>>;

const execFile = promisify(execFileCb);

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

export type BranchLandStatus = "landed" | "unlanded" | "missing" | "error";

export interface WorktreeGcOpts {
  services: Services;
  /** How old (ms) a terminal worktree must be before GC. Default 2h. */
  gracePeriodMs?: number;
  /**
   * Probe whether `branch` is safe to reap from the home repo's perspective.
   *   - "landed":   branch is an ancestor of main; commits are preserved.
   *   - "missing":  branch ref no longer exists; nothing to preserve.
   *   - "unlanded": branch has commits not in main; reap would lose work.
   *   - "error":    probe itself failed; treat as unlanded (fail-safe).
   * Defaults to a git-based probe against the home repo when omitted.
   */
  branchLandedCheck?: (branch: string) => Promise<BranchLandStatus>;
  /** Override main branch name probed by the default check. Defaults to "main". */
  mainBranch?: string;
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
  unlanded_skipped: string[];
}

const DEFAULT_GRACE_PERIOD_MS = 2 * 60 * 60_000;

function buildDefaultBranchLandedCheck(
  mainRepoDir: string,
  mainBranch: string,
): (branch: string) => Promise<BranchLandStatus> {
  return async (branch: string): Promise<BranchLandStatus> => {
    try {
      await execFile("git", ["-C", mainRepoDir, "rev-parse", "--verify", "--quiet", branch]);
    } catch (err) {
      const code = (err as { code?: number | string | null }).code;
      // git rev-parse --verify --quiet exits 1 when the ref doesn't exist;
      // any other failure shape is unexpected and must defer.
      if (code === 1) return "missing";
      return "error";
    }
    try {
      await execFile("git", ["-C", mainRepoDir, "merge-base", "--is-ancestor", branch, mainBranch]);
      return "landed";
    } catch (err) {
      const code = (err as { code?: number | string | null }).code;
      // is-ancestor exits 1 when not an ancestor; that's a clean "unlanded".
      // Anything else (128 missing ref, spawn failure, etc.) is an error.
      if (code === 1) return "unlanded";
      return "error";
    }
  };
}

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
  const mainBranch = opts.mainBranch ?? "main";
  const branchLandedCheck =
    opts.branchLandedCheck ??
    buildDefaultBranchLandedCheck(services.worktreeManager.mainRepoDir, mainBranch);
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
  const unlanded_skipped: string[] = [];

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

      const landStatus = await branchLandedCheck(candidate.branch);
      if (landStatus === "unlanded" || landStatus === "error") {
        deferred.push(candidate.handoff_id);
        unlanded_skipped.push(candidate.handoff_id);
        services.dispatchEventLog.record({
          handoff_id: candidate.handoff_id,
          source: "daemon",
          // Cast until `worktree.gc.unlanded_skipped` lands in the shared
          // api-contract enum; the local schema in this branch already lists it.
          kind: "worktree.gc.unlanded_skipped" as DispatchEventInput["kind"],
          ts: now().toISOString(),
          meta: {
            handoff_id: candidate.handoff_id,
            branch: candidate.branch,
            status: candidate.status,
            land_status: landStatus,
          },
        });
        opts.log?.warn?.(
          {
            handoff_id: candidate.handoff_id,
            branch: candidate.branch,
            land_status: landStatus,
          },
          "worktree-gc skipped unlanded branch",
        );
        continue;
      }

      const teardownResult: TeardownResult = await services.worktreeManager.teardownWorktree(
        candidate.handoff_id,
        /*force=*/ true,
      );

      // In-flight guard: only emit worktree.gc when the teardown actually
      // removed the worktree. A no-op return (e.g. handle already gone after
      // a concurrent sweep) would otherwise spawn phantom dispatch events.
      if (!teardownResult.worktreeRemoved) {
        opts.log?.debug?.(
          { handoff_id: candidate.handoff_id, branch: candidate.branch },
          "worktree-gc teardown reported no-op; skipping dispatch event",
        );
        continue;
      }

      services.dispatchEventLog.record({
        handoff_id: candidate.handoff_id,
        source: "daemon",
        kind: "worktree.gc",
        ts: now().toISOString(),
        meta: {
          handoff_id: candidate.handoff_id,
          branch_name: candidate.branch,
          branch_sha: teardownResult.branchSha,
          branch_deleted: teardownResult.branchDeleted,
          status: candidate.status,
          age_ms: candidate.age_ms,
          reason: candidate.reason,
          land_status: landStatus,
        },
      });

      removed.push(candidate.handoff_id);
    } catch (err) {
      opts.log?.warn?.(
        { handoff_id: candidate.handoff_id, err: String(err) },
        "worktree-gc teardown failed; skipping",
      );
      failed.push(candidate.handoff_id);
    }
  }

  return { candidates, removed, failed, deferred, unlanded_skipped };
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
