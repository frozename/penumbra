import type { Database } from "bun:sqlite";
import type { Logger } from "@penumbra/core";

export interface StaleWorkerTokensSweepOpts {
  db: Database;
  log?: Logger;
  staleWindowMs: number;
}

export interface StartStaleWorkerTokensSweeperOpts {
  db: Database;
  log?: Logger;
  staleWindowMs?: number;
}

export interface StaleWorkerTokensSweepResult {
  revokedCount: number;
}

export function runStaleWorkerTokensSweep(
  opts: StaleWorkerTokensSweepOpts,
  now: () => Date = () => new Date(),
): StaleWorkerTokensSweepResult {
  const nowMs = now().getTime();
  const cutoff = nowMs - opts.staleWindowMs;

  opts.db.run(
    "UPDATE worker_tokens SET revoked_at = ? WHERE last_seen_at < ? AND revoked_at IS NULL",
    [nowMs, cutoff],
  );

  const revoked = opts.db.query<{ c: number }, []>("SELECT changes() AS c").get();
  const revokedCount = revoked?.c ?? 0;

  if (revokedCount > 0) {
    opts.log?.info?.({ revokedCount, cutoff }, "worker-tokens.stale-sweep revoked");
  }
  return { revokedCount };
}

export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_STALE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export function startStaleWorkerTokensSweeper(
  opts: StartStaleWorkerTokensSweeperOpts,
  intervalMs: number = process.env.PENUMBRA_WORKER_TOKEN_SWEEP_INTERVAL_MS
    ? Number(process.env.PENUMBRA_WORKER_TOKEN_SWEEP_INTERVAL_MS)
    : DEFAULT_INTERVAL_MS,
  now: () => Date = () => new Date(),
): () => void {
  const staleWindowMs =
    opts.staleWindowMs ??
    (process.env.PENUMBRA_WORKER_TOKEN_STALE_MS
      ? Number(process.env.PENUMBRA_WORKER_TOKEN_STALE_MS)
      : DEFAULT_STALE_WINDOW_MS);
  const runOpts: StaleWorkerTokensSweepOpts = { ...opts, staleWindowMs };

  const timer = setInterval(() => {
    try {
      runStaleWorkerTokensSweep(runOpts, now);
    } catch (err) {
      opts.log?.warn?.({ err: String(err) }, "stale-worker-tokens sweep failed");
    }
  }, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  return () => clearInterval(timer);
}
