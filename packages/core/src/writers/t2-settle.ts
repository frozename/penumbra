export { DEFAULT_T2_PROMOTION_DELAY_HOURS } from "../settings.js";

// A t1 rollup is settled for T2 once it ended, or while still open started,
// before the promotion-delay cutoff. Binds the cutoff twice. Shared with
// dreaming P1 v2 so both owners read one gate.
export const T2_SETTLED_ROLLUP_SQL = "(ended_at < ? OR (ended_at IS NULL AND started_at < ?))";

export function t2PromotionCutoffIso(delayHours: number, nowMs: number): string {
  return new Date(nowMs - delayHours * 3600_000).toISOString();
}
