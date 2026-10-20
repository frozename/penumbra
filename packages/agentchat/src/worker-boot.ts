import {
  type BootReconcileLogger,
  reconcileDispatchOrphansAtWorkerBoot,
  reconcileOrphansAtWorkerBoot,
} from "@src/worker/boot-reconcile.js";

import type { PenumbraClient } from "./penumbra-client.js";

export interface WorkerBootLogger extends BootReconcileLogger {
  error(meta: Record<string, unknown>, msg: string): void;
}

export interface WorkerBootOutbox {
  drain(opts?: { budgetMs?: number }): Promise<{ remaining: number }>;
}

const OUTBOX_BOOT_DRAIN_BUDGET_MS = 30_000;
const DISPATCH_RECONCILE_DEFER_MAX_MS = 10 * 60 * 1_000;

export interface WorkerBootControl {
  drainOutbox(): Promise<void>;
  stop(): void;
}

function scheduleDeferred(run: () => Promise<void>, delayMs: number): { cancel(): void } {
  const timer = setTimeout(() => {
    void run();
  }, delayMs);
  timer.unref();
  return {
    cancel: (): void => {
      clearTimeout(timer);
    },
  };
}

export async function runWorkerBoot(args: {
  client: Pick<
    PenumbraClient,
    "registerWorker" | "postHeartbeat" | "reconcileDispatchOrphans" | "reconcileLongLivedOrphans"
  >;
  log: WorkerBootLogger;
  workerId: string;
  workerMetadata?: Record<string, unknown>;
  outbox?: WorkerBootOutbox;
  now?: () => number;
  schedule?: (run: () => Promise<void>, delayMs: number) => { cancel(): void };
}): Promise<WorkerBootControl> {
  const now = args.now ?? Date.now;
  // Captured before registration and any dispatch claim: rows this incarnation
  // claims after the boot instant must never enter an orphan reconcile.
  const claimedBefore = new Date(now()).toISOString();
  const reconcileDeadline = now() + DISPATCH_RECONCILE_DEFER_MAX_MS;
  let deferred = false;
  let timer: { cancel(): void } | undefined;
  const resumeReconcile = async (): Promise<void> => {
    if (!deferred) return;
    deferred = false;
    timer?.cancel();
    await reconcileDispatchOrphansAtWorkerBoot({ ...args, claimedBefore }, undefined, true);
  };
  const control: WorkerBootControl = {
    drainOutbox: async () => {
      const result = await args.outbox?.drain();
      if (result?.remaining === 0) await resumeReconcile();
    },
    stop: () => {
      deferred = false;
      timer?.cancel();
    },
  };
  try {
    await args.client.registerWorker({ worker_id: args.workerId, metadata: args.workerMetadata });
  } catch (err) {
    args.log.error({ err }, "worker registration failed; aborting boot");
    throw err;
  }
  // Replay pending terminal reports before orphan reconcile so the daemon sees
  // the true outcome before it considers requeueing the worker's rows.
  // Pending reports defer requeueing finished turns, but only up to the boot
  // bound so genuinely orphaned rows do not wait for the stale sweeper.
  let outboxBusy = false;
  if (args.outbox !== undefined) {
    try {
      const { remaining } = await args.outbox.drain({ budgetMs: OUTBOX_BOOT_DRAIN_BUDGET_MS });
      if (remaining > 0) {
        outboxBusy = true;
        args.log.warn(
          { event: "boot_dispatch_reconcile_deferred", remaining },
          "terminal outbox still holds records; deferring dispatch orphan reconcile",
        );
      }
    } catch (err) {
      outboxBusy = true;
      args.log.warn(
        { event: "boot_dispatch_reconcile_deferred", err },
        "terminal outbox drain failed; deferring dispatch orphan reconcile",
      );
    }
  }
  if (process.env.PENUMBRA_BOOT_RECONCILE === "0") {
    args.log.info(
      { event: "boot_reconcile_skipped", reason: "supervisor_managed" },
      "boot orphan reconcile skipped",
    );
    return control;
  }
  if (outboxBusy) {
    deferred = true;
    timer = (args.schedule ?? scheduleDeferred)(
      resumeReconcile,
      Math.max(0, reconcileDeadline - now()),
    );
  }
  await reconcileOrphansAtWorkerBoot({
    client: args.client,
    log: args.log,
    workerId: args.workerId,
    skipDispatchOrphans: outboxBusy,
    claimedBefore,
  });
  return control;
}
