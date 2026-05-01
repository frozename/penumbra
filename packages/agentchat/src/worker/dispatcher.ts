import type { Logger } from '@penumbra/core';
import type { DispatchEventInput } from '@penumbra/core';
import type { DispatchHandoffResult } from '../cli/dispatch-handoff.js';
import { PenumbraHttpError, isTerminalHttpStatus } from '../penumbra-client.js';

export interface WorkerDispatcherDeps {
  claim: (handoff_id: string) => Promise<{ status: string }>;
  dispatch: (handoff: any, onChunk: (delta: string) => void, signal: AbortSignal) => Promise<DispatchHandoffResult>;
  postProgress: (handoff_id: string, payload: any) => Promise<void>;
  complete: (handoff_id: string) => Promise<void>;
  log: Logger;
  concurrency: number;
  /**
   * Called when a chain terminated.
   */
  onChainEnd?: (handoff: any, reason: string) => void;
  /**
   * Called when a claim attempt fails for a retryable reason (network blip, 5xx,
   * 408, 429). The host (e.g. the worker bin) should mark the handoff_id as
   * eligible for re-discovery so a future SSE/poll event re-triggers handle().
   * Without this, dedup state in the event source would suppress the row.
   */
  onClaimRetryable?: (handoff_id: string) => void;
  onEvent?: (event: DispatchEventInput) => void;
  workerId?: string;
}

export interface WorkerDispatcher {
  handle(handoff: any): Promise<void>;
  /** Aborts any active dispatch for the given conversation. */
  cancel(conversation_id: string, handoff_id?: string): void;
  /** Resolves once no in-flight or queued handoffs remain. */
  idle(): Promise<void>;
  /** Aborts all active dispatches and clears state. */
  stop(): void;
}

export function createWorkerDispatcher(deps: WorkerDispatcherDeps): WorkerDispatcher {
  const convLocks = new Map<string, Promise<void>>();
  const activeAborts = new Map<string, { handoff_id: string; abort: AbortController }>();
  // Two pre-dispatch cancel sets: handoff-id-scoped (preferred — daemon emits
  // hid on every cancel event) and conversation-id-scoped (legacy fallback for
  // callers that pass cancel(conv) with no hid).
  const pendingCancelsByHandoff = new Set<string>();
  const pendingCancelsByConv = new Set<string>();
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

    const abort = new AbortController();
    if (pendingCancelsByHandoff.has(handoff.handoff_id) || pendingCancelsByConv.has(handoff.conversation_id)) {
      deps.log.info({ conversation_id: handoff.conversation_id, handoff_id: handoff.handoff_id }, 'applying pre-dispatch cancellation');
      pendingCancelsByHandoff.delete(handoff.handoff_id);
      pendingCancelsByConv.delete(handoff.conversation_id);
      abort.abort();
    }
    activeAborts.set(handoff.conversation_id, { handoff_id: handoff.handoff_id, abort });

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

      const dispatchStart = Date.now();
      let dispatchStatus: 'ok' | 'error' | 'aborted' = 'ok';
      deps.onEvent?.({
        handoff_id: handoff.handoff_id,
        worker_id: deps.workerId,
        source: 'worker',
        kind: 'dispatch.start',
        ts: new Date().toISOString(),
        meta: {
          agent: handoff.to_agent,
          adapter: handoff.adapter ?? 'unknown',
          prompt_bytes: typeof handoff.message === 'string' ? Buffer.byteLength(handoff.message) : 0,
        },
      });

      // Progress reporting state
      let buffer = '';
      let seq = 0;
      let inflightProgress: Promise<void> | null = null;
      let batchTimer: Timer | null = null;

      const flush = async () => {
        if (inflightProgress || buffer.length === 0) return;
        const delta = buffer;
        buffer = '';
        const currentSeq = ++seq;
        
        // Use an async IIFE to wrap the postProgress + cooldown into a single flight
        inflightProgress = (async () => {
          try {
            await deps.postProgress(handoff.handoff_id, {
              type: 'token',
              handoff_id: handoff.handoff_id,
              seq: currentSeq,
              delta,
            });
          } catch (err) {
            const status = err instanceof PenumbraHttpError ? err.status : null;
            if (status === 410) {
              deps.log.warn({ handoff_id: handoff.handoff_id }, 'progress rejected (410 Gone); aborting hop');
              abort.abort();
            } else {
              deps.log.debug({ handoff_id: handoff.handoff_id, err: String(err) }, 'postProgress failed');
            }
          } finally {
            // Min 100ms interval between flights to avoid overwhelming the daemon
            await new Promise((resolve) => setTimeout(resolve, 100));
            inflightProgress = null;
            if (buffer.length > 0) {
              void flush();
            }
          }
        })();
      };

      try {
        await deps.postProgress(handoff.handoff_id, {
          type: 'hop-start',
          handoff_id: handoff.handoff_id,
          chain_id: handoff.conversation_id, // Fallback to conversation_id if no explicit chain_id
          idx: handoff.hop_idx ?? 0,
          agent_name: handoff.to_agent,
          status: 'in_progress',
        });

        const result = await deps.dispatch(
          handoff,
          (delta) => {
            buffer += delta;
            if (!inflightProgress && !batchTimer) {
              batchTimer = setTimeout(() => {
                batchTimer = null;
                void flush();
              }, 100);
            }
          },
          abort.signal,
        );

        if (batchTimer) {
          clearTimeout(batchTimer);
          batchTimer = null;
        }

        // Ensure last delta is flushed before hop-end
        await inflightProgress;
        if (buffer.length > 0) {
          await deps.postProgress(handoff.handoff_id, {
            type: 'token',
            handoff_id: handoff.handoff_id,
            seq: ++seq,
            delta: buffer,
          });
        }

        await deps.postProgress(handoff.handoff_id, {
          type: 'hop-end',
          handoff_id: handoff.handoff_id,
          chain_id: handoff.conversation_id,
          text: result.text,
          next_handoff_id: result.next?.handoff_id ?? result.cappedHandoffId ?? null,
          error: result.terminatedReason === 'error' ? 'dispatch error' : null,
        });

        if (result.terminatedReason) {
          const reasonMap: Record<string, string> = {
            no_mention: 'completed',
            max_hops: 'max_hops',
            untrusted: 'cancelled',
            error: 'error',
          };
          const reason = reasonMap[result.terminatedReason] ?? 'completed';
          await deps.postProgress(handoff.handoff_id, {
            type: 'chain-end',
            chain_id: handoff.conversation_id,
            reason,
          } as any);
          deps.onChainEnd?.(handoff, reason);
        }
      } catch (err) {
        dispatchStatus = abort.signal.aborted ? 'aborted' : 'error';
        const status = err instanceof PenumbraHttpError ? err.status : null;
        if (status === 410) {
          deps.log.debug({ handoff_id: handoff.handoff_id }, 'progress rejected (handoff already terminal)');
        } else {
          deps.log.warn({ handoff_id: handoff.handoff_id, err: String(err) }, 'dispatch threw');
        }
      } finally {
        deps.onEvent?.({
          handoff_id: handoff.handoff_id,
          worker_id: deps.workerId,
          source: 'worker',
          kind: 'dispatch.end',
          ts: new Date().toISOString(),
          meta: { status: dispatchStatus, wall_ms: Date.now() - dispatchStart },
        });
        try {
          await deps.complete(handoff.handoff_id);
        } catch (err) {
          if (err instanceof PenumbraHttpError && err.status === 409) {
            deps.log.debug({ handoff_id: handoff.handoff_id, err: String(err) }, 'completeHandoff conflict (likely already terminal)');
          } else {
            deps.log.warn({ handoff_id: handoff.handoff_id, err: String(err) }, 'completeHandoff failed');
          }
        }
      }
    } finally {
      activeAborts.delete(handoff.conversation_id);
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
    cancel(conversation_id: string, handoff_id?: string) {
      const entry = activeAborts.get(conversation_id);
      const matched = !!entry && (handoff_id === undefined || entry.handoff_id === handoff_id);
      deps.onEvent?.({
        handoff_id: handoff_id ?? entry?.handoff_id ?? '',
        worker_id: deps.workerId,
        source: 'worker',
        kind: 'cancel.dispatched',
        ts: new Date().toISOString(),
        meta: { matched },
      });
      // Match the active dispatch by handoff_id when the caller provided one
      // (daemon control events always do). If hid is omitted (legacy in-process
      // callers), fall back to conv-scoped match. This guards against stale
      // cancel events — replayed by the daemon's durable-flush on every SSE
      // reconnect — killing a fresh dispatch that happens to share conv_id.
      if (matched) {
        deps.log.info({ conversation_id, handoff_id }, 'aborting active dispatch via control event');
        entry.abort.abort();
      } else if (handoff_id !== undefined) {
        pendingCancelsByHandoff.add(handoff_id);
      } else {
        pendingCancelsByConv.add(conversation_id);
      }
    },
    async idle() {
      while (inflight.size > 0) {
        await Promise.allSettled(Array.from(inflight));
      }
      pendingCancelsByHandoff.clear();
      pendingCancelsByConv.clear();
    },
    stop() {
      for (const entry of activeAborts.values()) {
        entry.abort.abort();
      }
      activeAborts.clear();
      pendingCancelsByHandoff.clear();
      pendingCancelsByConv.clear();
    },
  };
}
