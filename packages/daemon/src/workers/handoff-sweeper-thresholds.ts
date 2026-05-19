const DEFAULT_DISPATCHED_TTL_MS = 30 * 60_000;
const DEFAULT_PENDING_TTL_MS = 60 * 60_000;

const DISPATCHED_TTL_MS: Record<string, number> = {
  review_adversarial: 45 * 60_000,
  implement_substantial: 60 * 60_000,
  implement_small: 30 * 60_000,
  plan_refine: 30 * 60_000,
  docs_mechanical: 20 * 60_000,
  debug_diagnose: 45 * 60_000,
  smoke_test: 10 * 60_000,
  health_check: 5 * 60_000,
};

export const MIN_DISPATCHED_TTL_MS = Math.min(DEFAULT_DISPATCHED_TTL_MS, ...Object.values(DISPATCHED_TTL_MS));

export function resolveDispatchedTtlMs(taskType: string | null | undefined): number {
  if (!taskType) return DEFAULT_DISPATCHED_TTL_MS;
  return DISPATCHED_TTL_MS[taskType] ?? DEFAULT_DISPATCHED_TTL_MS;
}

export function resolvePendingTtlMs(): number {
  return DEFAULT_PENDING_TTL_MS;
}
