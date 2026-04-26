import type { Logger } from '@penumbra/core';
import type { DispatchHandoffResult } from '../cli/dispatch-handoff.js';

export interface WorkerDispatcherDeps {
  claim: (handoff_id: string) => Promise<{ status: string }>;
  dispatch: (handoff: any) => Promise<DispatchHandoffResult>;
  log: Logger;
  concurrency: number;
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
        deps.log.debug({ handoff_id: handoff.handoff_id, err: String(err) }, 'claim failed; skipping');
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
      const p = handleOne(handoff);
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
