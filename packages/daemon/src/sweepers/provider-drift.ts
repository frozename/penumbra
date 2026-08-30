type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

interface SweeperLog {
  info?: (obj: Record<string, unknown>, msg: string) => void;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

export const DEFAULT_PROVIDER_DRIFT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Node/Bun's setInterval takes a signed 32-bit ms delay; anything above this
 * is silently normalized to 1ms internally, turning a large "infrequent
 * sweep" config value into a hot loop.
 */
const MAX_SAFE_SET_INTERVAL_MS = 2147483647;

/**
 * The only argv this feature ever uses: a dry-run discovery probe. The
 * apply flag must never appear in this file — the sweeper reports drift;
 * a human reviews and applies it manually.
 */
export const PROVIDER_DRIFT_DRY_RUN_ARGV = ["config", "sync-providers", "--dry-run"] as const;

export interface ProviderDriftSweepDeps {
  runDiscoveryDryRun: () => Promise<{ exitCode: number; stdout: string[]; stderr: string[] }>;
  now?: () => Date;
  log?: SweeperLog;
}

export type ProviderDriftAction = "converged" | "drift" | "suspect_empty" | "discovery_failed";

export interface ProviderDriftCounts {
  wouldUpsert: number;
  wouldAlias: number;
  wouldPrune: number;
  edgesLit: number;
  warnings: number;
  providersSkipped: number;
}

export interface ProviderDriftSweepResult {
  action: ProviderDriftAction;
  counts?: ProviderDriftCounts;
  violations?: string[];
}

/**
 * Cross-tick state. The drift classification itself is stateless; the state
 * object exists for shape parity with the other sweepers and future
 * once-semantics.
 */
export type ProviderDriftSweepState = Record<string, never>;

export function createProviderDriftSweepState(): ProviderDriftSweepState {
  return {};
}

const ZERO_RESULTS_SKIPPED_RE = /skipped: .*zero results/;

function isSuspectEmptyLine(line: string): boolean {
  return (
    line.includes("no provider sources configured") ||
    ZERO_RESULTS_SKIPPED_RE.test(line) ||
    line.includes("discovery incomplete; skipping prune step")
  );
}

function isSkippedProviderLine(line: string): boolean {
  return line.startsWith("provider ") && line.includes(" skipped: ");
}

function countDriftSignals(stdout: string[]): ProviderDriftCounts {
  const counts: ProviderDriftCounts = {
    wouldUpsert: 0,
    wouldAlias: 0,
    wouldPrune: 0,
    edgesLit: 0,
    warnings: 0,
    providersSkipped: 0,
  };
  for (const line of stdout) {
    if (line.startsWith("would upsert ")) counts.wouldUpsert += 1;
    else if (line.startsWith("would alias ")) counts.wouldAlias += 1;
    else if (line.startsWith("would prune ")) counts.wouldPrune += 1;
    else if (line.startsWith("edge lit (no seat): ")) counts.edgesLit += 1;
    else if (line.startsWith("warning: ")) counts.warnings += 1;
    else if (isSkippedProviderLine(line)) counts.providersSkipped += 1;
  }
  return counts;
}

function isDriftLine(line: string): boolean {
  return (
    line.startsWith("would upsert ") ||
    line.startsWith("would alias ") ||
    line.startsWith("would prune ") ||
    line.startsWith("edge lit (no seat): ") ||
    line.startsWith("warning: ")
  );
}

function collectSafetyGateViolations(stderr: string[]): string[] {
  const gateIndex = stderr.findIndex((line) => line.includes("safety gate failed"));
  if (gateIndex === -1) return [];
  const violations: string[] = [];
  for (const line of stderr.slice(gateIndex + 1)) {
    if (!line.startsWith("  - ")) break;
    violations.push(line.slice("  - ".length));
  }
  return violations;
}

/**
 * Classifies one dry-run discovery probe. Fail-closed: a suspicious-empty or
 * incomplete discovery is "suspect_empty", never "converged", and a nonzero
 * exit is "discovery_failed". The sweeper never writes config.
 */
export async function runProviderDriftSweep(
  deps: ProviderDriftSweepDeps,
  _state: ProviderDriftSweepState,
): Promise<ProviderDriftSweepResult> {
  const { exitCode, stdout, stderr } = await deps.runDiscoveryDryRun();

  if (exitCode !== 0) {
    const violations = collectSafetyGateViolations(stderr);
    deps.log?.warn?.(
      { exitCode, violations, stderrTail: stderr.slice(-5) },
      "provider-drift: discovery dry-run failed (dry-run only; nothing was applied)",
    );
    return violations.length > 0
      ? { action: "discovery_failed", violations }
      : { action: "discovery_failed" };
  }

  const counts = countDriftSignals(stdout);

  if (stdout.some(isSuspectEmptyLine) || counts.providersSkipped > 0) {
    deps.log?.warn?.(
      { counts, skippedProviderLines: stdout.filter(isSkippedProviderLine) },
      "provider-drift: discovery suspect-empty or incomplete; treating report as untrustworthy (never auto-applies)",
    );
    return { action: "suspect_empty", counts };
  }

  if (
    counts.wouldUpsert + counts.wouldAlias + counts.wouldPrune + counts.edgesLit + counts.warnings >
    0
  ) {
    deps.log?.info?.(
      { counts, driftLines: stdout.filter(isDriftLine).slice(0, 10) },
      "provider-drift: drift detected — run `penumbra config sync-providers` and review, then --apply manually (sweeper never applies)",
    );
    return { action: "drift", counts };
  }

  deps.log?.info?.({ counts }, "provider-drift: no drift");
  return { action: "converged", counts };
}

export function startProviderDriftSweeper(
  deps: ProviderDriftSweepDeps,
  intervalMs: number = DEFAULT_PROVIDER_DRIFT_SWEEP_INTERVAL_MS,
): () => void {
  // Fail closed against a non-finite/non-positive/oversized interval reaching
  // setInterval (which Node/Bun clamp to ~1ms outside the int32 range, causing
  // a hot loop) even if a future caller bypasses the config-layer validation.
  const effectiveIntervalMs =
    Number.isFinite(intervalMs) && intervalMs > 0 && intervalMs <= MAX_SAFE_SET_INTERVAL_MS
      ? intervalMs
      : DEFAULT_PROVIDER_DRIFT_SWEEP_INTERVAL_MS;

  const state = createProviderDriftSweepState();
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runProviderDriftSweep(deps, state);
    } catch (err) {
      deps.log?.warn?.({ err: String(err) }, "provider-drift: sweep failed unexpectedly");
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, effectiveIntervalMs);
  // Unref only after the first tick settles, so an otherwise-idle process
  // doesn't exit while the initial probe is still in flight.
  void tick().finally(() => {
    maybeUnref(timer);
  });

  return () => {
    clearInterval(timer);
  };
}
