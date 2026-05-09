/**
 * Centralized polling intervals for TanStack Query and similar pollers.
 *
 * Why this exists: 5s is the default heartbeat for the operator console; 30s for
 * less-hot lists. Keeping these as named constants makes tuning a one-file change.
 */

/** Interval for live operator data. */
export const HEARTBEAT_MS = 5_000;

/** Interval for cooler data such as recently-resolved history. */
export const COOL_POLL_MS = 30_000;
