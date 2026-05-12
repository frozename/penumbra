const DEFAULT_THRESHOLD_MS = 15 * 60_000;

const THRESHOLDS_MS: Record<string, number> = {
  review_adversarial: 30 * 60_000,
  implement_substantial: 30 * 60_000,
  implement_small: 15 * 60_000,
  plan_refine: 15 * 60_000,
  docs_mechanical: 15 * 60_000,
  debug_diagnose: 15 * 60_000,
  smoke_test: 5 * 60_000,
  health_check: 5 * 60_000,
};

export function resolveStaleAfterMs(taskType: string | null | undefined): number {
  if (!taskType) return DEFAULT_THRESHOLD_MS;
  return THRESHOLDS_MS[taskType] ?? DEFAULT_THRESHOLD_MS;
}

export function allConfiguredThresholdsMs(): number[] {
  return [DEFAULT_THRESHOLD_MS, ...Object.values(THRESHOLDS_MS)];
}

export function resolveSweeperSqlCutoffMs(staleAfterMs: number | ((taskType: string | null | undefined) => number)): number {
  return typeof staleAfterMs === 'function'
    ? Math.min(...allConfiguredThresholdsMs())
    : staleAfterMs;
}
