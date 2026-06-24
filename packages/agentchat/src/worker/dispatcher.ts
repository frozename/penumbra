import type { DispatchEventInput, Logger } from "@penumbra/core";

import type { DispatchHandoffResult } from "../cli/dispatch-handoff.js";
import type { DiscordNotificationEvent } from "./discord-events.js";

import { detectClassifierDecline } from "../classifier-decline.js";
import { isTerminalHttpStatus, PenumbraHttpError } from "../penumbra-client.js";

/**
 * Minimal structural shape the dispatcher reads off a handoff row. Public
 * callbacks are generic over `H extends DispatcherHandoff` so consumers can
 * pass HandoffRow (or any extended shape) into dispatch/onChainEnd/etc. and
 * read their own fields without a per-callback cast.
 */
export interface DispatcherHandoff {
  handoff_id: string;
  conversation_id: string;
  project_id?: string | null;
  to_agent: string;
  message?: string;
  adapter?: string | null;
  hop_idx?: number;
  use_worktree?: boolean | null;
  isolated_install?: boolean | null;
}

export interface WorkerDispatcherDeps<H extends DispatcherHandoff = DispatcherHandoff> {
  claim: (handoff_id: string) => Promise<{ status: string }>;
  dispatch: (
    handoff: H,
    onChunk: (delta: string) => void,
    signal: AbortSignal,
  ) => Promise<DispatchHandoffResult>;
  postProgress: (handoff_id: string, payload: Record<string, unknown>) => Promise<void>;
  complete: (handoff_id: string) => Promise<void>;
  /**
   * Marks a handoff durably failed with an error summary. Invoked instead of
   * complete() when a dispatch ends in error so the row stays recoverable
   * (retry / sweep) instead of being masked as a successful completion.
   */
  markFailed: (handoff_id: string, reason: string) => Promise<void>;
  log: Logger;
  concurrency: number;
  /**
   * Called when a chain terminated.
   */
  onChainEnd?: (
    handoff: H,
    reason: string,
    worktreeChanged: boolean | null,
    dirty: boolean | null,
    committed: boolean | null,
    wallMs: number | null,
    frameworkOverheadMs: number | null,
    finalResponseText: string | null,
  ) => void;
  /**
   * Optional recovery hook invoked for completed chains that ended with a
   * dirty worktree but no explicit commit. The worker provides the concrete
   * git add/commit implementation.
   */
  autocommitOnChainEnd?: (handoff: H) => Promise<void>;
  /**
   * Called when a claim attempt fails for a retryable reason (network blip, 5xx,
   * 408, 429). The host (e.g. the worker bin) should mark the handoff_id as
   * eligible for re-discovery so a future SSE/poll event re-triggers handle().
   * Without this, dedup state in the event source would suppress the row.
   */
  onClaimRetryable?: (handoff_id: string) => void;
  onEvent?: (event: DispatchEventInput) => void;
  onDispatchEvent?: (event: DiscordNotificationEvent) => void;
  dispatchStartBarrier?: (event: DispatchEventInput) => Promise<void>;
  workerId?: string;
  /**
   * Optional pre-claim grace (ms) for cross-project warm-pooled handoffs: a
   * worker that is NOT home for the handoff's project holds back this long so a
   * home-repoRoot worker (which owns the matching warm connection) wins the
   * first-poll claim and reuses it instead of cold-starting. Returns 0 to claim
   * immediately (home worker, non-warm agent, or affinity disabled). The grace
   * is awaited BEFORE the conv-lock/semaphore, so it never pins a slot; if no
   * home worker claims within it, this worker still claims (overflow preserved).
   * See worker/claim-affinity.ts.
   */
  claimGraceMs?: (handoff: H) => number;
  /** Injectable delay (test seam); defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
  /**
   * Optional probe invoked just before dispatch.end emission. The result is
   * persisted into dispatch.end's meta so the dispatch reliability classifier
   * can detect "completed" handoffs that produced no actual file changes —
   * notably the gemini-acp pattern of reporting success without writing
   * anything. Captured here (not in the audit) because by the time an
   * operator reviews, main may have moved past the worktree's HEAD,
   * destroying the signal.
   */
  getWorktreeSnapshot?: (handoffId: string) => Promise<SnapshotResult>;
}

export interface WorkerDispatcher<H extends DispatcherHandoff = DispatcherHandoff> {
  handle(handoff: H): Promise<void>;
  /** Aborts any active dispatch for the given conversation. */
  cancel(conversation_id: string, handoff_id?: string): void;
  /** Resolves once no in-flight or queued handoffs remain. */
  idle(): Promise<void>;
  /** Aborts all active dispatches and clears state. */
  stop(): void;
  /** @internal Test-only diagnostics. Not part of the runtime contract. */
  __internals(): { claimRetryStateSize: number };
}

interface SnapshotResult {
  worktreeChanged: boolean | null;
  dirty: boolean | null;
  committed: boolean | null;
}

interface ClaimRetryEntry {
  attempts: number;
  resumeAtMs: number;
}

interface ProgressState {
  buffer: string;
  seq: number;
  inflightProgress: Promise<void> | null;
  batchTimer: ReturnType<typeof setTimeout> | null;
}

interface DispatchSnapshotState {
  captured: SnapshotResult | null;
}

interface DispatchOutcomeState {
  status: "ok" | "error" | "aborted";
  result: DispatchHandoffResult | null;
  errorText: string | null;
}

interface DispatchLifecycleContext {
  abort: AbortController;
  dispatchStart: number;
  snapshot: DispatchSnapshotState;
  outcome: DispatchOutcomeState;
  progress: ProgressState;
}

interface Semaphore {
  acquire: () => Promise<void>;
  release: () => void;
}

interface ConvLocks {
  acquire: (conv: string) => Promise<() => void>;
}

const STALE_CLAIM_RETRY_MS = 5 * 60_000;
const MAX_CLAIM_RETRY_STATE = 1_000;
const CLAIM_BACKOFF_CAP_MS = 30_000;
const CLAIM_BACKOFF_BASE_MS = 1_000;
const PROGRESS_BATCH_MS = 100;
const PROGRESS_COOLDOWN_MS = 100;

function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function makeSemaphore(initial: number): Semaphore {
  let value = initial;
  const waiters: (() => void)[] = [];
  return {
    acquire: (): Promise<void> => {
      if (value > 0) {
        value--;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    release: (): void => {
      const next = waiters.shift();
      if (next) {
        next();
      } else {
        value++;
      }
    },
  };
}

function makeConvLocks(): ConvLocks {
  const locks = new Map<string, Promise<void>>();
  return {
    acquire: async (conv: string): Promise<() => void> => {
      let existing = locks.get(conv);
      while (existing !== undefined) {
        await existing;
        existing = locks.get(conv);
      }
      let release!: () => void;
      const p = new Promise<void>((r) => {
        release = r;
      });
      locks.set(conv, p);
      return (): void => {
        locks.delete(conv);
        release();
      };
    },
  };
}

function claimRetryDelayMs(attempts: number): number {
  const backoff = Math.min(
    CLAIM_BACKOFF_CAP_MS,
    CLAIM_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
  );
  const jitter = backoff * (0.2 * Math.random());
  return Math.min(CLAIM_BACKOFF_CAP_MS, Math.round(backoff + jitter));
}

// Bound claimRetryState so a handoff that fails a retryable claim and then
// goes terminal upstream (e.g. orphan sweeper marks it failed) before any
// re-claim does not leak an entry forever. STALE drops expired-backoff entries;
// MAX is a hard ceiling that drops the oldest entries first.
function evictStaleClaimRetryState(claimRetryState: Map<string, ClaimRetryEntry>): void {
  if (claimRetryState.size === 0) {
    return;
  }
  const now = Date.now();
  for (const [hid, state] of claimRetryState) {
    if (now - state.resumeAtMs > STALE_CLAIM_RETRY_MS) {
      claimRetryState.delete(hid);
    }
  }
  while (claimRetryState.size > MAX_CLAIM_RETRY_STATE) {
    const oldestKey = claimRetryState.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    claimRetryState.delete(oldestKey);
  }
}

function emitClaimRetryEvent(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  err: unknown,
): void {
  deps.onDispatchEvent?.({
    kind: "claim_retry",
    handoff_id: handoff.handoff_id,
    conversation_id: handoff.conversation_id,
    project_id: handoff.project_id ?? undefined,
    agent: handoff.to_agent,
    worker_id: deps.workerId,
    error_summary: err instanceof Error ? err.message : String(err),
  });
}

async function attemptClaim(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  claimRetryState: Map<string, ClaimRetryEntry>,
): Promise<{ ok: true } | { ok: false }> {
  try {
    await deps.claim(handoff.handoff_id);
    claimRetryState.delete(handoff.handoff_id);
    return { ok: true };
  } catch (err: unknown) {
    const status = err instanceof PenumbraHttpError ? err.status : null;
    const isTerminal = status !== null && isTerminalHttpStatus(status);
    if (isTerminal) {
      deps.log.debug(
        { handoff_id: handoff.handoff_id, status, err: String(err) },
        "claim failed; terminal",
      );
      return { ok: false };
    }
    scheduleClaimRetry(deps, handoff, claimRetryState, err, status);
    return { ok: false };
  }
}

function scheduleClaimRetry(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  claimRetryState: Map<string, ClaimRetryEntry>,
  err: unknown,
  status: number | null,
): void {
  const now = Date.now();
  const previous = claimRetryState.get(handoff.handoff_id);
  if (previous && now < previous.resumeAtMs) {
    deps.log.debug(
      {
        handoff_id: handoff.handoff_id,
        status,
        err: String(err),
        retry_after_ms: previous.resumeAtMs - now,
      },
      "claim failed; retryable but backoff active",
    );
    // The host may have cleared dedup state for this handoff_id (SSE reconnect,
    // daemon restart, in-memory eviction) since the prior retry was scheduled.
    // Re-arm so the row remains eligible for re-discovery past resumeAtMs even
    // though the log/dispatch_event side effects are rate-limited here.
    deps.onClaimRetryable?.(handoff.handoff_id);
    return;
  }
  const attempts = (previous?.attempts ?? 0) + 1;
  const resumeAtMs = now + claimRetryDelayMs(attempts);
  claimRetryState.set(handoff.handoff_id, { attempts, resumeAtMs });
  deps.log.warn(
    { handoff_id: handoff.handoff_id, status, err: String(err) },
    "claim failed; retryable, will be re-tried on next event",
  );
  emitClaimRetryEvent(deps, handoff, err);
  deps.onClaimRetryable?.(handoff.handoff_id);
}

function buildDispatchStartEvent(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
): DispatchEventInput {
  return {
    handoff_id: handoff.handoff_id,
    worker_id: deps.workerId,
    source: "worker",
    kind: "dispatch.start",
    ts: new Date().toISOString(),
    meta: {
      agent: handoff.to_agent,
      adapter: handoff.adapter ?? "unknown",
      prompt_bytes: Buffer.byteLength(handoff.message ?? ""),
    },
  };
}

async function runDispatchStartBarrier(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  event: DispatchEventInput,
  dispatchStart: number,
): Promise<{ ok: true } | { ok: false }> {
  if (!deps.dispatchStartBarrier) {
    deps.onEvent?.(event);
    return { ok: true };
  }
  try {
    await deps.dispatchStartBarrier(event);
    return { ok: true };
  } catch (err: unknown) {
    const errText = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      { handoff_id: handoff.handoff_id, err: errText },
      "dispatch.start barrier failed; not spawning dispatch",
    );
    await finalizeBarrierFailure(deps, handoff, dispatchStart, errText);
    return { ok: false };
  }
}

async function finalizeBarrierFailure(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  dispatchStart: number,
  errText: string,
): Promise<void> {
  // Don't return silently — that strands the row until the orphan sweeper picks
  // it up. Mirror the regular dispatch-error finally: emit a dispatch.end with
  // status=error so the lifecycle is observable, then mark the row terminal via
  // complete(). If complete() also fails (the daemon is likely the reason the
  // barrier failed), fall back to onClaimRetryable so the worker forgets dedup
  // state and re-picks the row on the next SSE/poll event.
  deps.onEvent?.({
    handoff_id: handoff.handoff_id,
    worker_id: deps.workerId,
    source: "worker",
    kind: "dispatch.end",
    ts: new Date().toISOString(),
    meta: {
      status: "error",
      wall_ms: Date.now() - dispatchStart,
      error_summary: `dispatch_start_barrier_failed: ${errText}`,
    },
  });
  try {
    await deps.complete(handoff.handoff_id);
  } catch (completeErr: unknown) {
    deps.log.debug(
      { handoff_id: handoff.handoff_id, err: String(completeErr) },
      "complete after dispatch.start barrier failure also failed; marking retryable",
    );
    deps.onClaimRetryable?.(handoff.handoff_id);
  }
}

function emitDispatchStartDiscord(deps: WorkerDispatcherDeps, handoff: DispatcherHandoff): void {
  deps.onDispatchEvent?.({
    kind: "dispatch_start",
    handoff_id: handoff.handoff_id,
    conversation_id: handoff.conversation_id,
    project_id: handoff.project_id ?? undefined,
    agent: handoff.to_agent,
    worker_id: deps.workerId,
  });
}

function makeProgressFlusher(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  progress: ProgressState,
  abort: AbortController,
): () => void {
  const flush = (): void => {
    if (progress.inflightProgress !== null || progress.buffer.length === 0) {
      return;
    }
    const delta = progress.buffer;
    progress.buffer = "";
    progress.seq += 1;
    const currentSeq = progress.seq;
    progress.inflightProgress = runProgressFlight(
      deps,
      handoff,
      progress,
      abort,
      flush,
      delta,
      currentSeq,
    );
  };
  return flush;
}

async function runProgressFlight(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  progress: ProgressState,
  abort: AbortController,
  flush: () => void,
  delta: string,
  currentSeq: number,
): Promise<void> {
  try {
    await deps.postProgress(handoff.handoff_id, {
      type: "token",
      handoff_id: handoff.handoff_id,
      seq: currentSeq,
      delta,
    });
  } catch (err: unknown) {
    const status = err instanceof PenumbraHttpError ? err.status : null;
    if (status === 410) {
      deps.log.warn(
        { handoff_id: handoff.handoff_id },
        "progress rejected (410 Gone); aborting hop",
      );
      abort.abort();
    } else {
      deps.log.debug({ handoff_id: handoff.handoff_id, err: String(err) }, "postProgress failed");
    }
  } finally {
    // Min interval between flights to avoid overwhelming the daemon.
    await defaultDelay(PROGRESS_COOLDOWN_MS);
    progress.inflightProgress = null;
    if (progress.buffer.length > 0) {
      flush();
    }
  }
}

async function captureSnapshotOnce(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  snapshot: DispatchSnapshotState,
): Promise<void> {
  if (snapshot.captured !== null || !deps.getWorktreeSnapshot) {
    return;
  }
  try {
    snapshot.captured = await deps.getWorktreeSnapshot(handoff.handoff_id);
  } catch (err: unknown) {
    deps.log.debug(
      { handoff_id: handoff.handoff_id, err: String(err) },
      "getWorktreeSnapshot failed; recording null",
    );
    snapshot.captured = { worktreeChanged: null, dirty: null, committed: null };
  }
}

async function reprobeSnapshot(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  snapshot: DispatchSnapshotState,
): Promise<void> {
  if (!deps.getWorktreeSnapshot) {
    return;
  }
  try {
    snapshot.captured = await deps.getWorktreeSnapshot(handoff.handoff_id);
  } catch (err: unknown) {
    deps.log.debug(
      { handoff_id: handoff.handoff_id, err: String(err) },
      "getWorktreeSnapshot failed after autocommit; keeping prior snapshot",
    );
  }
}

function snapshotOrNull(snapshot: DispatchSnapshotState): SnapshotResult {
  return snapshot.captured ?? { worktreeChanged: null, dirty: null, committed: null };
}

async function maybeAutocommit(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  snapshot: DispatchSnapshotState,
  reason: string,
): Promise<void> {
  const current = snapshotOrNull(snapshot);
  if (
    reason !== "completed" ||
    current.dirty !== true ||
    current.committed !== false ||
    !deps.autocommitOnChainEnd
  ) {
    return;
  }
  try {
    await deps.autocommitOnChainEnd(handoff);
    await reprobeSnapshot(deps, handoff, snapshot);
    deps.onDispatchEvent?.({
      kind: "autocommit_on_chain_end",
      handoff_id: handoff.handoff_id,
      conversation_id: handoff.conversation_id,
      project_id: handoff.project_id ?? undefined,
      agent: handoff.to_agent,
      worker_id: deps.workerId,
    });
  } catch (err: unknown) {
    deps.log.warn(
      {
        component: "autocommit-on-chain-end",
        handoff_id: handoff.handoff_id,
        err: String(err),
      },
      "autocommit on chain end failed",
    );
  }
}

function reasonForTerminated(terminatedReason: string | undefined): string {
  const reasonMap: Record<string, string> = {
    no_mention: "completed",
    max_hops: "max_hops",
    untrusted: "cancelled",
    error: "error",
  };
  if (terminatedReason === undefined) {
    return "completed";
  }
  return reasonMap[terminatedReason] ?? "completed";
}

function frameworkOverheadMsOf(result: DispatchHandoffResult | null): number | null {
  const value = result?.meta?.framework_overhead_ms;
  return typeof value === "number" ? value : null;
}

function finalTextOf(result: DispatchHandoffResult | null): string | null {
  return typeof result?.text === "string" ? result.text : null;
}

async function handleHopCompletion(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  ctx: DispatchLifecycleContext,
  result: DispatchHandoffResult,
): Promise<void> {
  if (!result.terminatedReason) {
    return;
  }
  const reason = reasonForTerminated(result.terminatedReason);
  await deps.postProgress(handoff.handoff_id, {
    type: "chain-end",
    chain_id: handoff.conversation_id,
    reason,
  });
  // Capture the worktree snapshot here so it's available to onChainEnd hooks.
  // Memoised — the finally block reuses the same value when emitting
  // dispatch.end so the probe runs at most once per dispatch.
  await captureSnapshotOnce(deps, handoff, ctx.snapshot);
  // onChainEnd sees the pre-autocommit state (the trigger that caused the
  // recovery). dispatch.end meta later reflects the post-autocommit state
  // because the finally block re-reads ctx.snapshot, which maybeAutocommit
  // mutates in place.
  const preAutocommit = snapshotOrNull(ctx.snapshot);
  await maybeAutocommit(deps, handoff, ctx.snapshot, reason);
  deps.onChainEnd?.(
    handoff,
    reason,
    preAutocommit.worktreeChanged,
    preAutocommit.dirty,
    preAutocommit.committed,
    Date.now() - ctx.dispatchStart,
    frameworkOverheadMsOf(ctx.outcome.result),
    finalTextOf(ctx.outcome.result),
  );
}

async function flushTailProgress(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  progress: ProgressState,
): Promise<void> {
  if (progress.batchTimer !== null) {
    clearTimeout(progress.batchTimer);
    progress.batchTimer = null;
  }
  // Ensure last delta is flushed before hop-end.
  if (progress.inflightProgress !== null) {
    await progress.inflightProgress;
  }
  if (progress.buffer.length > 0) {
    progress.seq += 1;
    await deps.postProgress(handoff.handoff_id, {
      type: "token",
      handoff_id: handoff.handoff_id,
      seq: progress.seq,
      delta: progress.buffer,
    });
    progress.buffer = "";
  }
}

function emitAdapterRetryExhausted(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  errorSummary?: string,
): void {
  deps.onDispatchEvent?.({
    kind: "adapter_retry_exhausted",
    handoff_id: handoff.handoff_id,
    conversation_id: handoff.conversation_id,
    project_id: handoff.project_id ?? undefined,
    agent: handoff.to_agent,
    worker_id: deps.workerId,
    ...(errorSummary !== undefined ? { error_summary: errorSummary } : {}),
  });
}

async function runDispatchBody(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  ctx: DispatchLifecycleContext,
): Promise<void> {
  const flush = makeProgressFlusher(deps, handoff, ctx.progress, ctx.abort);
  await deps.postProgress(handoff.handoff_id, {
    type: "hop-start",
    handoff_id: handoff.handoff_id,
    // Fallback to conversation_id if no explicit chain_id.
    chain_id: handoff.conversation_id,
    idx: handoff.hop_idx ?? 0,
    agent_name: handoff.to_agent,
    status: "in_progress",
  });
  const onChunk = (delta: string): void => {
    ctx.progress.buffer += delta;
    if (ctx.progress.inflightProgress === null && ctx.progress.batchTimer === null) {
      ctx.progress.batchTimer = setTimeout(() => {
        ctx.progress.batchTimer = null;
        flush();
      }, PROGRESS_BATCH_MS);
    }
  };
  const result = await deps.dispatch(handoff, onChunk, ctx.abort.signal);
  ctx.outcome.result = result;
  classifyResult(deps, handoff, ctx, result);
  await flushTailProgress(deps, handoff, ctx.progress);
  await deps.postProgress(handoff.handoff_id, {
    type: "hop-end",
    handoff_id: handoff.handoff_id,
    chain_id: handoff.conversation_id,
    text: result.text,
    next_handoff_id: result.next?.handoff_id ?? result.cappedHandoffId ?? null,
    error: result.terminatedReason === "error" ? "dispatch error" : null,
  });
  await handleHopCompletion(deps, handoff, ctx, result);
}

function classifyResult(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  ctx: DispatchLifecycleContext,
  result: DispatchHandoffResult,
): void {
  if (ctx.abort.signal.aborted) {
    ctx.outcome.status = "aborted";
    return;
  }
  if (result.terminatedReason === "error") {
    ctx.outcome.status = "error";
    emitAdapterRetryExhausted(deps, handoff);
  }
}

function handleDispatchException(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  ctx: DispatchLifecycleContext,
  err: unknown,
): void {
  ctx.outcome.status = ctx.abort.signal.aborted ? "aborted" : "error";
  ctx.outcome.errorText = err instanceof Error ? err.message : String(err);
  const status = err instanceof PenumbraHttpError ? err.status : null;
  if (status === 410) {
    deps.log.debug(
      { handoff_id: handoff.handoff_id },
      "progress rejected (handoff already terminal)",
    );
    return;
  }
  deps.log.warn({ handoff_id: handoff.handoff_id, err: String(err) }, "dispatch threw");
  emitAdapterRetryExhausted(deps, handoff, ctx.outcome.errorText);
}

interface ClassifierDecline {
  classifier_declined: true;
  decline_reason: "provider_safety_refusal";
}

function getMetaClassifierDecline(result: DispatchHandoffResult | null): ClassifierDecline | null {
  if (result?.meta?.classifier_declined !== true) {
    return null;
  }
  return {
    classifier_declined: true,
    decline_reason: "provider_safety_refusal",
  };
}

function resolveClassifierDecline(ctx: DispatchLifecycleContext): ClassifierDecline | null {
  const fromMeta = getMetaClassifierDecline(ctx.outcome.result);
  if (fromMeta) {
    return fromMeta;
  }
  const fromHeuristic = detectClassifierDecline({
    finalText: ctx.outcome.result?.text ?? null,
    errorText: ctx.outcome.errorText,
  });
  return fromHeuristic ?? null;
}

function buildDispatchEndMeta(ctx: DispatchLifecycleContext): Record<string, unknown> {
  const snap = snapshotOrNull(ctx.snapshot);
  const overhead = frameworkOverheadMsOf(ctx.outcome.result);
  const decline = resolveClassifierDecline(ctx);
  return {
    status: ctx.outcome.status,
    wall_ms: Date.now() - ctx.dispatchStart,
    ...(overhead !== null ? { framework_overhead_ms: overhead } : {}),
    ...(snap.worktreeChanged !== null ? { worktree_changed: snap.worktreeChanged } : {}),
    ...(snap.dirty !== null ? { dirty: snap.dirty } : {}),
    ...(snap.committed !== null ? { committed: snap.committed } : {}),
    ...(decline ?? {}),
  };
}

async function finalizeDispatch(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  ctx: DispatchLifecycleContext,
): Promise<void> {
  // Reuse the snapshot captured before onChainEnd if it ran; otherwise probe
  // now (e.g. paths where the try block threw before reaching the chain-end
  // hook).
  await captureSnapshotOnce(deps, handoff, ctx.snapshot);
  deps.onEvent?.({
    handoff_id: handoff.handoff_id,
    worker_id: deps.workerId,
    source: "worker",
    kind: "dispatch.end",
    ts: new Date().toISOString(),
    meta: buildDispatchEndMeta(ctx),
  });
  if (ctx.outcome.status === "error") {
    await failDispatch(deps, handoff, ctx);
    return;
  }
  try {
    await deps.complete(handoff.handoff_id);
  } catch (err: unknown) {
    if (err instanceof PenumbraHttpError && err.status === 409) {
      deps.log.debug(
        { handoff_id: handoff.handoff_id, err: String(err) },
        "completeHandoff conflict (likely already terminal)",
      );
      return;
    }
    deps.log.warn({ handoff_id: handoff.handoff_id, err: String(err) }, "completeHandoff failed");
  }
}

// An errored dispatch must NOT be marked completed: that durably masks the
// failure and suppresses retry/recovery (sweepers, re-dispatch). Route it
// through markFailed with the error summary instead. Idempotent against an
// already-terminal row (e.g. dispatchHandoff already failed it) via 409.
async function failDispatch(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  ctx: DispatchLifecycleContext,
): Promise<void> {
  const reason = ctx.outcome.errorText ?? "dispatch error";
  try {
    await deps.markFailed(handoff.handoff_id, reason);
  } catch (err: unknown) {
    if (err instanceof PenumbraHttpError && err.status === 409) {
      deps.log.debug(
        { handoff_id: handoff.handoff_id, err: String(err) },
        "markFailed conflict (likely already terminal)",
      );
      return;
    }
    deps.log.warn({ handoff_id: handoff.handoff_id, err: String(err) }, "markFailed failed");
  }
}

async function runDispatchLifecycle(
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  ctx: DispatchLifecycleContext,
): Promise<void> {
  const startEvent = buildDispatchStartEvent(deps, handoff);
  const barrier = await runDispatchStartBarrier(deps, handoff, startEvent, ctx.dispatchStart);
  if (!barrier.ok) {
    return;
  }
  emitDispatchStartDiscord(deps, handoff);
  try {
    await runDispatchBody(deps, handoff, ctx);
  } catch (err: unknown) {
    handleDispatchException(deps, handoff, ctx, err);
  } finally {
    await finalizeDispatch(deps, handoff, ctx);
  }
}

function consumePendingCancel(
  pending: { byHandoff: Set<string>; byConv: Set<string> },
  deps: WorkerDispatcherDeps,
  handoff: DispatcherHandoff,
  abort: AbortController,
): void {
  if (!pending.byHandoff.has(handoff.handoff_id) && !pending.byConv.has(handoff.conversation_id)) {
    return;
  }
  deps.log.info(
    { conversation_id: handoff.conversation_id, handoff_id: handoff.handoff_id },
    "applying pre-dispatch cancellation",
  );
  pending.byHandoff.delete(handoff.handoff_id);
  pending.byConv.delete(handoff.conversation_id);
  abort.abort();
}

interface DispatcherState {
  deps: WorkerDispatcherDeps;
  convLocks: ConvLocks;
  semaphore: Semaphore;
  activeAborts: Map<string, { handoff_id: string; abort: AbortController }>;
  claimRetryState: Map<string, ClaimRetryEntry>;
  pendingCancelsByHandoff: Set<string>;
  pendingCancelsByConv: Set<string>;
  inflight: Set<Promise<void>>;
  delay: (ms: number) => Promise<void>;
}

async function handleOne(state: DispatcherState, handoff: DispatcherHandoff): Promise<void> {
  evictStaleClaimRetryState(state.claimRetryState);
  // Cross-project claim affinity. Hold back before claiming so a home-repoRoot
  // worker wins the first-poll race and reuses its warm connection. Awaited
  // BEFORE the conv-lock + semaphore so the grace never pins a slot; if no
  // home worker claims within it, this worker proceeds and claims (overflow
  // capacity preserved).
  const graceMs = state.deps.claimGraceMs?.(handoff) ?? 0;
  if (graceMs > 0) {
    await state.delay(graceMs);
  }
  const releaseLock = await state.convLocks.acquire(handoff.conversation_id);
  await state.semaphore.acquire();
  const abort = new AbortController();
  consumePendingCancel(
    { byHandoff: state.pendingCancelsByHandoff, byConv: state.pendingCancelsByConv },
    state.deps,
    handoff,
    abort,
  );
  state.activeAborts.set(handoff.conversation_id, { handoff_id: handoff.handoff_id, abort });
  try {
    const claim = await attemptClaim(state.deps, handoff, state.claimRetryState);
    if (!claim.ok) {
      return;
    }
    const ctx: DispatchLifecycleContext = {
      abort,
      dispatchStart: Date.now(),
      snapshot: { captured: null },
      outcome: { status: "ok", result: null, errorText: null },
      progress: { buffer: "", seq: 0, inflightProgress: null, batchTimer: null },
    };
    await runDispatchLifecycle(state.deps, handoff, ctx);
  } finally {
    state.activeAborts.delete(handoff.conversation_id);
    state.semaphore.release();
    releaseLock();
  }
}

function emitCancelEvent(
  deps: WorkerDispatcherDeps,
  conversation_id: string,
  handoff_id: string | undefined,
  entry: { handoff_id: string; abort: AbortController } | undefined,
  matched: boolean,
): void {
  deps.onEvent?.({
    handoff_id: handoff_id ?? entry?.handoff_id ?? "",
    worker_id: deps.workerId,
    source: "worker",
    kind: "cancel.dispatched",
    ts: new Date().toISOString(),
    meta: { matched },
  });
}

function handleCancel(state: DispatcherState, conversation_id: string, handoff_id?: string): void {
  const entry = state.activeAborts.get(conversation_id);
  // Match the active dispatch by handoff_id when the caller provided one
  // (daemon control events always do). If hid is omitted (legacy in-process
  // callers), fall back to conv-scoped match. This guards against stale
  // cancel events — replayed by the daemon's durable-flush on every SSE
  // reconnect — killing a fresh dispatch that happens to share conv_id.
  const matched =
    entry !== undefined && (handoff_id === undefined || entry.handoff_id === handoff_id);
  emitCancelEvent(state.deps, conversation_id, handoff_id, entry, matched);
  if (matched) {
    state.deps.log.info(
      { conversation_id, handoff_id },
      "aborting active dispatch via control event",
    );
    entry.abort.abort();
    return;
  }
  if (handoff_id !== undefined) {
    state.pendingCancelsByHandoff.add(handoff_id);
  } else {
    state.pendingCancelsByConv.add(conversation_id);
  }
}

function dispatchToInflight(state: DispatcherState, handoff: DispatcherHandoff): void {
  // handleOne has its own try/finally and cannot reject in practice today, but
  // a defensive .catch keeps the floating Promise from ever surfacing as an
  // unhandledRejection if a future refactor changes that.
  const p = handleOne(state, handoff).catch((err: unknown) => {
    state.deps.log.warn(
      { handoff_id: handoff.handoff_id, err: String(err) },
      "handleOne unexpectedly rejected",
    );
  });
  state.inflight.add(p);
  void p.finally(() => state.inflight.delete(p));
}

export function createWorkerDispatcher<H extends DispatcherHandoff = DispatcherHandoff>(
  deps: WorkerDispatcherDeps<H>,
): WorkerDispatcher<H> {
  // Public API is generic over H so callers can type their dispatch/onChainEnd
  // hooks against their own row shape (HandoffRow + extensions). Internally
  // the dispatcher only reads DispatcherHandoff fields, so we launder once at
  // the boundary instead of threading H through every helper.
  const internalDeps = deps as unknown as WorkerDispatcherDeps;
  const state: DispatcherState = {
    deps: internalDeps,
    convLocks: makeConvLocks(),
    semaphore: makeSemaphore(deps.concurrency),
    activeAborts: new Map(),
    claimRetryState: new Map(),
    pendingCancelsByHandoff: new Set(),
    pendingCancelsByConv: new Set(),
    inflight: new Set(),
    delay: deps.delay ?? defaultDelay,
  };
  return {
    handle(handoff: H): Promise<void> {
      dispatchToInflight(state, handoff);
      // Don't await — let the caller decide via idle().
      return Promise.resolve();
    },
    cancel(conversation_id: string, handoff_id?: string): void {
      handleCancel(state, conversation_id, handoff_id);
    },
    async idle(): Promise<void> {
      while (state.inflight.size > 0) {
        await Promise.allSettled(Array.from(state.inflight));
      }
      state.pendingCancelsByHandoff.clear();
      state.pendingCancelsByConv.clear();
    },
    stop(): void {
      for (const entry of state.activeAborts.values()) {
        entry.abort.abort();
      }
      state.activeAborts.clear();
      state.pendingCancelsByHandoff.clear();
      state.pendingCancelsByConv.clear();
      state.claimRetryState.clear();
    },
    __internals: (): { claimRetryStateSize: number } => ({
      claimRetryStateSize: state.claimRetryState.size,
    }),
  };
}
