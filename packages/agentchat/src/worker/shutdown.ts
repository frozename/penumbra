export interface WorkerShutdownDeps {
  log: { info(meta: Record<string, unknown>, msg: string): void };
  controlAbort: { abort(reason?: unknown): void };
  heartbeatLoop: { stop(): void };
  prewarmAbort: { abort(reason?: unknown): void };
  prewarmLoop?: { stop(): void } | null;
  usagePoller?: { stop(): void } | null;
  notificationScheduler?: { stop(): void } | null;
  shutdownAllAcpWarmPools: () => void;
  eventSource: { stop(): Promise<void> | void };
  permissionDaemonClient: { stop(): void };
  dispatcher: { stop(): void; idle(): Promise<void> | void };
  eventQueue: { stop(): Promise<void> | void };
  exit: (code: number) => void;
}

export function createWorkerShutdown(deps: WorkerShutdownDeps): (sig: string) => Promise<void> {
  return async (sig: string) => {
    deps.log.info({ sig }, "shutting down");
    deps.controlAbort.abort();
    deps.prewarmAbort.abort(new Error("worker shutdown"));
    deps.prewarmLoop?.stop();
    deps.usagePoller?.stop();
    deps.notificationScheduler?.stop();
    deps.shutdownAllAcpWarmPools();
    await deps.eventSource.stop();
    deps.permissionDaemonClient.stop();
    deps.dispatcher.stop();
    await deps.dispatcher.idle();
    deps.heartbeatLoop.stop();
    await deps.eventQueue.stop();
    deps.exit(0);
  };
}
