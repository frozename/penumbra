import type { Logger } from '@penumbra/core';
import type { DispatchHandoffResult } from '../cli/dispatch-handoff.js';
import { PenumbraHttpError, isTerminalHttpStatus } from '../penumbra-client.js';

export interface WorkerDispatcherDeps {
  claim: (handoff_id: string) => Promise<{ status: string }>;
  dispatch: (handoff: any) => Promise<DispatchHandoffResult>;
  log: Logger;
  concurrency: number;
  /**
   * Called when a claim attempt fails for a retryable reason (network blip, 5xx,
   * 408, 429). The host (e.g. the worker bin) should mark the handoff_id as
   * eligible for re-discovery so a future SSE/poll event re-triggers handle().
   * Without this, dedup state in the event source would suppress the row.
   */
  onClaimRetryable?: (handoff_id: string) => void;
}

export interface WorkerDispatcher {
  handle(handoff: any): Promise<void>;
  /** Resolves once no in-flight or queued handoffs remain. */
  idle(): Promise<void>;
}

export function createWorkerDispatcher(deps: WorkerDispatcherDeps): WorkerDispatcher {
  const convLocks = new Map<string, Promise<void>>();
  let semaphore = deps.concurrency;
  const semaphoreWaiters: (() => void)[] = [];
  const inflight = new Set<Promise<void>>();

  const acquireSemaphore = (): Promise<void> => {
    if (semaphore > 0) { semaphore--; return Promise.resolve(); }
    return new Promise((resolve) => semaphoreWaiters.push(resolve));
  };
  const releaseSemaphore = () => {
    const next = semaphoreWaiters.shift();
    if (next) next();
    else semaphore++;
  };

  const acquireConvLock = async (conv: string): Promise<() => void> => {
    while (true) {
      const existing = convLocks.get(conv);
      if (!existing) break;
      await existing;
    }
    let release!: () => void;
    const p = new Promise<void>((r) => { release = r; });
    convLocks.set(conv, p);
    return () => {
      convLocks.delete(conv);
      release();
    };
  };

  const handleOne = async (handoff: any): Promise<void> => {
    const releaseLock = await acquireConvLock(handoff.conversation_id);
    await acquireSemaphore();
    try {
      try {
        await deps.claim(handoff.handoff_id);
      } catch (err) {
        // Distinguish a definitive "we lost / can't claim" outcome (404, 409,
        // most 4xx) from a transient one (network, 5xx, 408, 429). For
        // transient failures, ask the host to forget so the row can be picked
        // up again on the next event surfacing.
        const status = err instanceof PenumbraHttpError ? err.status : null;
        const isTerminal = status !== null && isTerminalHttpStatus(status);
        if (isTerminal) {
          deps.log.debug({ handoff_id: handoff.handoff_id, status, err: String(err) }, 'claim failed; terminal');
        } else {
          deps.log.warn({ handoff_id: handoff.handoff_id, status, err: String(err) }, 'claim failed; retryable, will be re-tried on next event');
          deps.onClaimRetryable?.(handoff.handoff_id);
        }
        return;
      }
      try {
        await deps.dispatch(handoff);
      } catch (err) {
        deps.log.warn({ handoff_id: handoff.handoff_id, err: String(err) }, 'dispatch threw');
      }
    } finally {
      releaseSemaphore();
      releaseLock();
    }
  };

  return {
    async handle(handoff: any) {
      // handleOne has its own try/finally and cannot reject in practice today,
      // but a defensive .catch keeps the floating Promise from ever surfacing
      // as an unhandledRejection if a future refactor changes that.
      const p = handleOne(handoff).catch((err) => {
        deps.log.warn({ handoff_id: handoff?.handoff_id, err: String(err) }, 'handleOne unexpectedly rejected');
      });
      inflight.add(p);
      p.finally(() => inflight.delete(p));
      // Don't await p here — let the caller decide via idle().
    },
    async idle() {
      while (inflight.size > 0) {
        await Promise.allSettled(Array.from(inflight));
      }
    },
  };
}
