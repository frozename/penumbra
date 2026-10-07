import { type PenumbraClient, PenumbraHttpError } from "../penumbra-client.js";

export interface BootReconcileLogger {
  info(meta: Record<string, unknown>, msg: string): void;
  warn(meta: Record<string, unknown>, msg: string): void;
}

export interface BootReconcileDeps {
  client: Pick<
    PenumbraClient,
    "reconcileLongLivedOrphans" | "reconcileDispatchOrphans" | "postHeartbeat"
  >;
  log: BootReconcileLogger;
  workerId: string;
  sleep?: (ms: number) => Promise<void>;
  // When the terminal outbox still holds records for this worker's rows after
  // the bounded boot drain, reconciling dispatch orphans would requeue rows
  // whose terminal report is about to be replayed — re-running a finished
  // turn on another worker.
  skipDispatchOrphans?: boolean;
  // Boot instant as ISO. Only rows claimed strictly before it may be
  // reconciled: rows this incarnation claimed after boot are live work.
  claimedBefore?: string;
}

export async function reconcileOrphansAtWorkerBoot(deps: BootReconcileDeps): Promise<void> {
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const heartbeat = async (): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await deps.client.postHeartbeat(deps.workerId);
        return;
      } catch (err) {
        if (attempt === 0) {
          deps.log.info({ err }, "daemon not ready; retrying heartbeat in 2s");
          await sleep(2000);
          continue;
        }
        deps.log.warn({ err }, "heartbeat call failed at worker boot; continuing");
      }
    }
  };

  const reconcileLongLived = async (): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await deps.client.reconcileLongLivedOrphans();
        if (resp.reconciled > 0) {
          deps.log.info(
            { reconciled: resp.reconciled },
            "long-lived orphan ticks reconciled at worker boot",
          );
        }
        return;
      } catch (err) {
        if (attempt === 0) {
          deps.log.info({ err }, "daemon not ready; retrying long-lived orphan reconcile in 2s");
          await sleep(2000);
          continue;
        }
        deps.log.warn(
          { err },
          "long-lived orphan reconcile call failed at worker boot; continuing",
        );
      }
    }
  };

  const results = await Promise.allSettled([
    heartbeat(),
    reconcileLongLived(),
    deps.skipDispatchOrphans === true
      ? Promise.resolve()
      : reconcileDispatchOrphansAtWorkerBoot(deps, sleep),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      deps.log.warn({ err: result.reason }, "boot-reconcile: step failed");
    }
  }
}

export async function reconcileDispatchOrphansAtWorkerBoot(
  deps: Pick<BootReconcileDeps, "client" | "log" | "workerId" | "claimedBefore">,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deferred = false,
): Promise<void> {
  const unsupported = (err?: unknown): void => {
    deps.log.warn(
      { event: "boot_dispatch_reconcile_unsupported", deferred, ...(err ? { err } : {}) },
      "daemon predates claimed_before support; skipping dispatch orphan reconcile",
    );
  };
  // A 400 on a bounded call means the daemon rejected claimed_before — an
  // older build. Never retry unfiltered: that would requeue live work.
  const rejectedBound = (err: unknown): boolean =>
    deps.claimedBefore !== undefined && err instanceof PenumbraHttpError && err.status === 400;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await deps.client.reconcileDispatchOrphans(deps.workerId, {
        claimed_before: deps.claimedBefore,
        require_claimed_before: deferred && deps.claimedBefore !== undefined,
      });
      if (resp.skipped === "unsupported_daemon") {
        unsupported();
        return;
      }
      logDispatchReconciled(deps.log, resp, deferred);
      return;
    } catch (err) {
      if (rejectedBound(err)) {
        unsupported(err);
        return;
      }
      if (attempt === 0) {
        deps.log.info({ err }, "daemon not ready; retrying dispatch orphan reconcile in 2s");
        await sleep(2000);
        continue;
      }
      deps.log.warn({ err }, "dispatch orphan reconcile call failed at worker boot; continuing");
    }
  }
}

function logDispatchReconciled(
  log: BootReconcileLogger,
  resp: { requeued: number; exhausted: number },
  deferred: boolean,
): void {
  if (!deferred && resp.requeued === 0 && resp.exhausted === 0) return;
  log.info(
    { ...resp, ...(deferred ? { event: "boot_dispatch_reconcile_resumed" } : {}) },
    deferred
      ? "deferred dispatch orphan reconcile ran"
      : "dispatch orphans reconciled at worker boot",
  );
}
