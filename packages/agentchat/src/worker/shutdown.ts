export interface WorkerShutdownDeps {
  log: {
    info(meta: Record<string, unknown>, msg: string): void;
    error?(meta: Record<string, unknown>, msg: string): void;
  };
  controlAbort: { abort(reason?: unknown): void };
  heartbeatLoop: { stop(): void };
  prewarmAbort: { abort(reason?: unknown): void };
  prewarmLoop?: { stop(): void } | null;
  getPrewarmLoop?: () => { stop(): void } | null;
  usagePoller?: { stop(): void } | null;
  notificationScheduler?: { stop(): void } | null;
  shutdownAllAcpWarmPools: () => void;
  eventSource: { stop(): Promise<void> | void };
  permissionDaemonClient: { stop(): void };
  dispatcher: { stop(): void; idle(): Promise<void> | void };
  eventQueue: { stop(): Promise<void> | void };
  exit: (code: number) => void;
  shutdownTimeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export function createWorkerShutdown(deps: WorkerShutdownDeps): (sig: string) => Promise<void> {
  return async (sig: string) => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const shutdown = async (): Promise<void> => {
      deps.log.info({ sig }, "shutting down");
      deps.controlAbort.abort();
      deps.prewarmAbort.abort(new Error("worker shutdown"));
      (deps.getPrewarmLoop?.() ?? deps.prewarmLoop)?.stop();
      deps.usagePoller?.stop();
      deps.notificationScheduler?.stop();
      deps.shutdownAllAcpWarmPools();
      await deps.eventSource.stop();
      deps.permissionDaemonClient.stop();
      deps.dispatcher.stop();
      await deps.dispatcher.idle();
      deps.heartbeatLoop.stop();
      await deps.eventQueue.stop();
      if (!timedOut) deps.exit(0);
    };

    await Promise.race([
      shutdown(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          deps.log.error?.({ sig }, "worker shutdown timed out");
          deps.exit(1);
          resolve();
        }, deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  };
}
