import {
  fetchAaModels,
  readAaApiKey,
  type AaFetchFailure,
  type AaSnapshotStore,
  type AaTransport,
  type FetchAaModelsOptions,
} from "@penumbra/core";

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

interface SweeperLog {
  info?: (obj: Record<string, unknown>, msg: string) => void;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

export const DEFAULT_AA_SNAPSHOT_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Node/Bun's setInterval takes a signed 32-bit ms delay; anything above this
 * is silently normalized to 1ms internally, turning a large "infrequent
 * refresh" config value into a hot loop.
 */
const MAX_SAFE_SET_INTERVAL_MS = 2147483647;

/** Ceiling applied to a server-supplied Retry-After before it becomes a backoff window. */
const MAX_AA_SNAPSHOT_BACKOFF_SECONDS = 60 * 60;

export interface AaSnapshotRefreshSweepDeps {
  aaSnapshotStore: AaSnapshotStore;
  transport?: AaTransport;
  apiKeyPath?: string;
  now?: () => Date;
  log?: SweeperLog;
  /** Forwarded to fetchAaModels (retry/timeout tuning); tests use this to avoid real sleeps. */
  fetchOptions?: Partial<
    Pick<
      FetchAaModelsOptions,
      "maxAttempts" | "retryDelayMs" | "maxRetryDelayMs" | "timeoutMs" | "sleep" | "endpoint"
    >
  >;
}

export type AaSnapshotRefreshAction =
  | "fresh"
  | "refreshed"
  | "unconfigured"
  | "fetch_failed"
  | "store_write_failed"
  | "backoff";

export interface AaSnapshotRefreshSweepResult {
  action: AaSnapshotRefreshAction;
  failureKind?: AaFetchFailure["kind"];
}

/**
 * Tracks the "log unconfigured once, not every tick" and 429 backoff state
 * across ticks. One instance per startAaSnapshotRefreshSweeper() call.
 */
export interface AaSnapshotRefreshSweepState {
  loggedUnconfigured: boolean;
  backoffUntilMs: number | undefined;
}

export function createAaSnapshotRefreshSweepState(): AaSnapshotRefreshSweepState {
  return { loggedUnconfigured: false, backoffUntilMs: undefined };
}

export async function runAaSnapshotRefreshSweep(
  deps: AaSnapshotRefreshSweepDeps,
  state: AaSnapshotRefreshSweepState,
): Promise<AaSnapshotRefreshSweepResult> {
  const now = deps.now ?? ((): Date => new Date());
  const nowMs = now().getTime();

  if (state.backoffUntilMs !== undefined && nowMs < state.backoffUntilMs) {
    return { action: "backoff" };
  }

  const current = await deps.aaSnapshotStore.read();
  if (current.state === "available" && !current.stale) {
    return { action: "fresh" };
  }

  const keyResult = await readAaApiKey(deps.apiKeyPath);
  if (keyResult.state === "unconfigured") {
    if (!state.loggedUnconfigured) {
      deps.log?.warn?.(
        {},
        "aa-snapshot-refresh: no Artificial Analysis API key configured; idling",
      );
      state.loggedUnconfigured = true;
    }
    return { action: "unconfigured" };
  }
  state.loggedUnconfigured = false;

  let capturedFailure: AaFetchFailure | undefined;
  const refreshResult = await deps.aaSnapshotStore.refresh(async () => {
    const fetched = await fetchAaModels({
      apiKey: keyResult.apiKey,
      transport: deps.transport,
      now,
      ...deps.fetchOptions,
    });
    if (!fetched.ok) {
      capturedFailure = fetched.error;
      throw new Error(fetched.error.message);
    }
    return {
      provenance: {
        collectedAt: fetched.snapshot.collectedAt,
        ...(fetched.snapshot.dataVersion !== undefined
          ? { dataVersion: fetched.snapshot.dataVersion }
          : {}),
        ...(fetched.snapshot.benchmarkVersion !== undefined
          ? { benchmarkVersion: fetched.snapshot.benchmarkVersion }
          : {}),
      },
      models: fetched.snapshot.models,
    };
  });

  if (capturedFailure) {
    deps.log?.warn?.(
      {
        kind: capturedFailure.kind,
        status: capturedFailure.status,
        attempts: capturedFailure.attempts,
        retryAfterSeconds: capturedFailure.retryAfterSeconds,
      },
      "aa-snapshot-refresh: fetch failed, keeping last-known-good",
    );
    if (
      capturedFailure.kind === "rate_limited" &&
      capturedFailure.retryAfterSeconds !== undefined
    ) {
      const clampedRetryAfterSeconds = Math.min(
        capturedFailure.retryAfterSeconds,
        MAX_AA_SNAPSHOT_BACKOFF_SECONDS,
      );
      state.backoffUntilMs = now().getTime() + clampedRetryAfterSeconds * 1000;
    }
    return { action: "fetch_failed", failureKind: capturedFailure.kind };
  }

  if (refreshResult.refreshError) {
    deps.log?.warn?.(
      { err: String(refreshResult.refreshError) },
      "aa-snapshot-refresh: fetch succeeded but persisting the snapshot failed; keeping last-known-good",
    );
    return { action: "store_write_failed" };
  }

  state.backoffUntilMs = undefined;
  return { action: "refreshed" };
}

export function startAaSnapshotRefreshSweeper(
  deps: AaSnapshotRefreshSweepDeps,
  intervalMs: number = DEFAULT_AA_SNAPSHOT_REFRESH_INTERVAL_MS,
): () => void {
  // Fail closed against a non-finite/non-positive/oversized interval reaching
  // setInterval (which Node/Bun clamp to ~1ms outside the int32 range, causing
  // a hot loop) even if a future caller bypasses the config-layer validation.
  const effectiveIntervalMs =
    Number.isFinite(intervalMs) && intervalMs > 0 && intervalMs <= MAX_SAFE_SET_INTERVAL_MS
      ? intervalMs
      : DEFAULT_AA_SNAPSHOT_REFRESH_INTERVAL_MS;

  const state = createAaSnapshotRefreshSweepState();
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runAaSnapshotRefreshSweep(deps, state);
    } catch (err) {
      deps.log?.warn?.({ err: String(err) }, "aa-snapshot-refresh: sweep failed unexpectedly");
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, effectiveIntervalMs);
  // Unref only after the first tick settles, so an otherwise-idle process
  // doesn't exit while the initial fetch is still in flight.
  void tick().finally(() => {
    maybeUnref(timer);
  });

  return () => {
    clearInterval(timer);
  };
}
