// One parser for every reader of PENUMBRA_WORKER_HEARTBEAT_STALE_MS: a zero, negative or
// non-numeric value must fall back to the same default everywhere, or the claim gates and
// the drain hold would disagree with the sweepers and the watchdog about which workers are live.
export const DEFAULT_WORKER_HEARTBEAT_STALE_MS = 90_000;

export function workerHeartbeatStaleMs(): number {
  const configured = Number(process.env.PENUMBRA_WORKER_HEARTBEAT_STALE_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WORKER_HEARTBEAT_STALE_MS;
}
