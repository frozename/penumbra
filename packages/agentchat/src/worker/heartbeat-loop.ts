import { PenumbraHttpError, isTerminalHttpStatus } from "../penumbra-client.js";
import { MAX_HEARTBEAT_ATTEMPTS, nextHeartbeatRetry } from "./heartbeat-retry.js";

export interface HeartbeatLoopLogger {
  debug(meta: Record<string, unknown>, msg: string): void;
  error(meta: Record<string, unknown>, msg: string): void;
  info(meta: Record<string, unknown>, msg: string): void;
  warn(meta: Record<string, unknown>, msg: string): void;
}

export interface HeartbeatLoopDeps {
  emitHeartbeat: (signal?: AbortSignal) => Promise<void>;
  reregisterWorker: () => Promise<void>;
  exit: (code: number) => void;
  schedule: (run: () => void | Promise<void>, delayMs: number) => { cancel(): void };
  log: HeartbeatLoopLogger;
  workerId: string;
  timeoutMs?: number;
}

export interface HeartbeatLoopControl {
  stop(): void;
}

const DEFAULT_HEARTBEAT_HTTP_TIMEOUT_MS = 10_000;
const HEARTBEAT_SUCCESS_DELAY_MS = 15_000;
// Caps SUCCESSFUL re-registration recoveries between healthy heartbeats (a
// failed re-register exits immediately). Reset on every successful heartbeat,
// so this breaks rapid terminal→re-register churn, not long-lived workers
// that recover isolated terminal events.
const MAX_REREGISTRATION_RECOVERIES = 3;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise.finally(() => {
      if (timer !== null) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`heartbeat_timeout_${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

export function startHeartbeatLoop(deps: HeartbeatLoopDeps): HeartbeatLoopControl {
  let stopped = false;
  let retryAttempt = 0;
  let reregistrationRecoveryCount = 0;
  let scheduled: { cancel(): void } | null = null;

  const scheduleNext = (delayMs: number): void => {
    if (stopped) return;
    scheduled = deps.schedule(async () => {
      if (stopped) return;
      try {
        const abortController = new AbortController();
        try {
          await withTimeout(
            deps.emitHeartbeat(abortController.signal),
            deps.timeoutMs ?? DEFAULT_HEARTBEAT_HTTP_TIMEOUT_MS,
          );
        } catch (err) {
          if (String(err).includes("heartbeat_timeout_")) abortController.abort();
          throw err;
        }
        if (stopped) return;
        retryAttempt = 0;
        reregistrationRecoveryCount = 0;
        if (stopped) return;
        scheduleNext(HEARTBEAT_SUCCESS_DELAY_MS);
      } catch (err) {
        if (stopped) return;
        const status = err instanceof PenumbraHttpError ? err.status : null;
        const isTerminal = status !== null && isTerminalHttpStatus(status);
        if (isTerminal) {
          deps.log.warn(
            { status, err: String(err) },
            "heartbeat terminal; attempting re-registration",
          );
          if (reregistrationRecoveryCount >= MAX_REREGISTRATION_RECOVERIES) {
            deps.log.error(
              { status, err: String(err), terminal_reregistrations: reregistrationRecoveryCount },
              "heartbeat terminal re-registration cap exceeded; stopping heartbeat loop",
            );
            if (stopped) return;
            deps.exit(1);
            return;
          }
          // Known bounded interplay: the client's internal 401-triggered
          // re-registration (withWorkerTokenRetry) shares the in-flight dedup
          // guard with this call but not this recovery cap; persistent 401s
          // still terminate via this loop's cap-then-exit path.
          try {
            await withTimeout(
              deps.reregisterWorker(),
              deps.timeoutMs ?? DEFAULT_HEARTBEAT_HTTP_TIMEOUT_MS,
            );
            if (stopped) return;
            reregistrationRecoveryCount++;
            retryAttempt = 0;
            if (stopped) return;
            // Probe immediately so the daemon sees liveness right after
            // re-registering; a healthy probe resets the recovery counter.
            scheduleNext(0);
          } catch (reRegisterErr) {
            if (stopped) return;
            deps.log.error(
              { err: String(reRegisterErr), status },
              "heartbeat failed permanently; worker may be unauthorized",
            );
            if (stopped) return;
            deps.exit(1);
          }
          return;
        }

        if (retryAttempt + 1 >= MAX_HEARTBEAT_ATTEMPTS) {
          deps.log.error(
            { err: String(err), attempts: MAX_HEARTBEAT_ATTEMPTS },
            "heartbeat retries exhausted; stopping heartbeat loop",
          );
          deps.exit(1);
          return;
        }
        const retry = nextHeartbeatRetry(retryAttempt);
        deps.log.debug(
          { err: String(err), backoff: retry.delayMs, nextAttempt: retry.nextAttempt },
          "heartbeat failed; retrying with backoff",
        );
        if (stopped) return;
        retryAttempt = retry.nextAttempt!;
        if (stopped) return;
        scheduleNext(retry.delayMs!);
      }
    }, delayMs);
  };

  scheduleNext(0);

  return {
    stop() {
      stopped = true;
      scheduled?.cancel();
    },
  };
}
