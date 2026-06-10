import { PenumbraHttpError, isTerminalHttpStatus } from "../penumbra-client.js";
import { MAX_HEARTBEAT_ATTEMPTS, nextHeartbeatRetry } from "./heartbeat-retry.js";

export interface HeartbeatLoopLogger {
  debug(meta: Record<string, unknown>, msg: string): void;
  error(meta: Record<string, unknown>, msg: string): void;
  info(meta: Record<string, unknown>, msg: string): void;
  warn(meta: Record<string, unknown>, msg: string): void;
}

export interface HeartbeatLoopDeps {
  emitHeartbeat: () => Promise<void>;
  reRegisterWorker: () => Promise<void>;
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`heartbeat_timeout_${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

export function startHeartbeatLoop(deps: HeartbeatLoopDeps): HeartbeatLoopControl {
  let stopped = false;
  let retryAttempt = 0;
  let scheduled: { cancel(): void } | null = null;

  const scheduleNext = (delayMs: number): void => {
    if (stopped) return;
    scheduled = deps.schedule(async () => {
      if (stopped) return;
      try {
        await withTimeout(
          deps.emitHeartbeat(),
          deps.timeoutMs ?? DEFAULT_HEARTBEAT_HTTP_TIMEOUT_MS,
        );
        retryAttempt = 0;
        scheduleNext(HEARTBEAT_SUCCESS_DELAY_MS);
      } catch (err) {
        const status = err instanceof PenumbraHttpError ? err.status : null;
        const isTerminal = status !== null && isTerminalHttpStatus(status);
        if (isTerminal) {
          deps.log.error(
            { status, err: String(err) },
            "heartbeat failed permanently; worker may be unauthorized",
          );
          try {
            await deps.reRegisterWorker();
            retryAttempt = 0;
            scheduleNext(HEARTBEAT_SUCCESS_DELAY_MS);
          } catch (reRegisterErr) {
            deps.log.error(
              { err: String(reRegisterErr), status },
              "worker re-registration after terminal heartbeat failed",
            );
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
        retryAttempt = retry.nextAttempt!;
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
