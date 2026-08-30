import {
  classifyBranchLandStatus,
  type BranchLandStatus as CoreBranchLandStatus,
  selectWorktreeGcCandidates,
  type Services,
  type WorktreeManager as WorktreeManagerLocal,
} from "@penumbra/core";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { lifecycleLock } from "../dispatch/lifecycle-lock.js";

type TeardownResult = Awaited<ReturnType<WorktreeManagerLocal["teardownWorktree"]>>;

const execFile = promisify(execFileCb);

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

export type BranchLandStatus = CoreBranchLandStatus | "missing";

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
  stage_reaped: string[];
  stage_deferred: string[];
}

const TERMINAL_HANDOFF_STATUSES = new Set(["completed", "failed", "rejected", "expired"]);

const DEFAULT_GRACE_PERIOD_MS = 2 * 60 * 60_000;
const UNLANDED_SKIPPED_SUMMARY_ID_LIMIT = 20;
const previousUnlandedSkippedByServices = new WeakMap<Services, Set<string>>();

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function recordUnlandedSkippedSummary(
  services: Services,
  handoffIds: string[],
  ts: string,
  log?: WorktreeGcOpts["log"],
): void {
  const current = new Set(handoffIds);
  const previous = previousUnlandedSkippedByServices.get(services);
  previousUnlandedSkippedByServices.set(services, current);

  if (handoffIds.length === 0) return;
  if (previous && setsEqual(previous, current)) {
    log?.debug?.(
      {
        count: handoffIds.length,
        handoff_ids: handoffIds.slice(0, UNLANDED_SKIPPED_SUMMARY_ID_LIMIT),
      },
      "worktree-gc skipped unlanded branch set unchanged",
    );
    return;
  }

  services.dispatchEventLog.record({
    handoff_id: handoffIds[0] ?? "worktree-gc",
    source: "daemon",
    // Cast until `worktree.gc.unlanded_skipped` lands in the shared
    // api-contract enum; the local schema in this branch already lists it.
    kind: "worktree.gc.unlanded_skipped",
    ts,
    meta: {
      count: handoffIds.length,
      handoff_ids: handoffIds.slice(0, UNLANDED_SKIPPED_SUMMARY_ID_LIMIT),
      truncated: handoffIds.length > UNLANDED_SKIPPED_SUMMARY_ID_LIMIT,
    },
  });
  log?.warn?.(
    {
      count: handoffIds.length,
      handoff_ids: handoffIds.slice(0, UNLANDED_SKIPPED_SUMMARY_ID_LIMIT),
      truncated: handoffIds.length > UNLANDED_SKIPPED_SUMMARY_ID_LIMIT,
    },
    "worktree-gc skipped unlanded branch set",
  );
}

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
    return await classifyBranchLandStatus(
      (cmd, args, opts) =>
        execFile(cmd, ["-C", mainRepoDir, ...args], {
          ...opts,
          encoding: opts?.encoding ?? "utf8",
        }),
      mainRepoDir,
      branch,
      mainBranch,
    );
  };
}

// Fail-closed stage/* reaper. stageMergedBase leaks a stage/<handoffId> ref
// on every call because worker/worktree-integration.ts and merge-reconciler.ts
// consume the NAME (not a captured SHA) hours later. We only reap a stage ref
// once every handoff whose branch_base points at it is terminal + past grace;
// on probe error or no referencing handoff we preserve the ref (fail-closed),
// mirroring verifyBranchDeleted's pattern.
async function reapStageBranches(
  services: Services,
  mainRepoDir: string,
  gracePeriodMs: number,
  nowMs: number,
  now: () => Date,
  log?: WorktreeGcOpts["log"],
): Promise<{ reaped: string[]; deferred: string[] }> {
  const reaped: string[] = [];
  const deferred: string[] = [];

  let refsOut: string;
  try {
    const { stdout } = await execFile("git", [
      "-C",
      mainRepoDir,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/stage/",
    ]);
    refsOut = stdout;
  } catch (err) {
    log?.warn?.({ err: String(err) }, "worktree-gc stage listing failed");
    return { reaped, deferred };
  }

  const refs = refsOut
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("stage/"));

  for (const ref of refs) {
    let rows: { status: string; resolved_at: string | null }[];
    try {
      rows = services.db
        .query<
          { status: string; resolved_at: string | null },
          [string]
        >("SELECT status, resolved_at FROM handoffs WHERE branch_base = ?")
        .all(ref);
    } catch (err) {
      deferred.push(ref);
      log?.warn?.(
        { ref, err: String(err) },
        "worktree-gc stage reap: handoff probe failed (fail-closed)",
      );
      continue;
    }

    if (rows.length === 0) {
      // No referencing handoff — preserve the ref. A concurrent plan-runtime
      // may still be racing to create the handoff row.
      deferred.push(ref);
      continue;
    }

    const allTerminalPastGrace = rows.every((row) => {
      if (!TERMINAL_HANDOFF_STATUSES.has(row.status)) return false;
      if (row.resolved_at === null) return false;
      const resolvedAtMs = new Date(row.resolved_at).getTime();
      if (!Number.isFinite(resolvedAtMs)) return false;
      return nowMs - resolvedAtMs >= gracePeriodMs;
    });

    if (!allTerminalPastGrace) {
      deferred.push(ref);
      continue;
    }

    try {
      await execFile("git", ["-C", mainRepoDir, "branch", "-D", ref]);
    } catch (err) {
      deferred.push(ref);
      log?.warn?.(
        { ref, err: String(err) },
        "worktree-gc stage reap: branch -D failed (fail-closed)",
      );
      continue;
    }

    reaped.push(ref);
    const handoffIdFromRef = ref.slice("stage/".length);
    services.dispatchEventLog.record({
      handoff_id: handoffIdFromRef,
      source: "daemon",
      // Cast until `worktree.gc.stage_reaped` propagates into the shared
      // api-contract node_modules copy; the local schema already lists it.
      kind: "worktree.gc.stage_reaped",
      ts: now().toISOString(),
      meta: {
        ref,
        referencing_handoffs: rows.length,
      },
    });
  }

  return { reaped, deferred };
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

  recordUnlandedSkippedSummary(services, unlanded_skipped, now().toISOString(), opts.log);

  const stageResult = lifecycleLock.isHeld()
    ? { reaped: [] as string[], deferred: [] as string[] }
    : await reapStageBranches(
        services,
        services.worktreeManager.mainRepoDir,
        gracePeriodMs,
        nowMs,
        now,
        opts.log,
      );

  return {
    candidates,
    removed,
    failed,
    deferred,
    unlanded_skipped,
    stage_reaped: stageResult.reaped,
    stage_deferred: stageResult.deferred,
  };
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
