import type { Services } from "@penumbra/core";

import type { PrSweepResult } from "./pr-orphan-sweeper.js";

import { runPrOrphanSweepForDaemon } from "../services/pr-orphan-sweep.js";

export interface ReconcilerSweepOpts {
  services: Services;
  maxClose?: number;
  dryRun?: boolean;
  log?: { warn?: (obj: unknown, msg?: string) => void };
  /** Injection point for testing — defaults to runPrOrphanSweepForDaemon. */
  runSweep?: (input: {
    services: Services;
    dryRun: boolean;
    maxClose?: number;
  }) => Promise<PrSweepResult>;
}

export interface ReconcilerSweepTickResult {
  closed: number;
  scanned: number;
  errors: number;
}

const DEFAULT_INTERVAL_MS = 30 * 60_000;
const DEFAULT_MAX_CLOSE = 20;

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

/**
 * One sweep tick: call runPrOrphanSweepForDaemon with dryRun:false, emit a
 * reconciler.sweep.tick dispatch event, and return counts. Catches all errors
 * so the recurring interval never crashes.
 */
export async function runReconcilerSweepTick(
  opts: ReconcilerSweepOpts,
): Promise<ReconcilerSweepTickResult | null> {
  const { services } = opts;
  const maxClose =
    opts.maxClose ??
    (process.env.PENUMBRA_RECONCILER_SWEEP_MAX_CLOSE
      ? Number(process.env.PENUMBRA_RECONCILER_SWEEP_MAX_CLOSE)
      : DEFAULT_MAX_CLOSE);
  const dryRun = opts.dryRun ?? services.settings.prOrphanSweeperDryRun;
  const runSweep = opts.runSweep ?? runPrOrphanSweepForDaemon;

  try {
    const result = await runSweep({ services, dryRun, maxClose });

    const closed = result.superseded + result.stale;
    const scanned = result.scanned;
    const errors = result.errored;

    const ts = new Date().toISOString();
    services.db
      .query<unknown, [string, string]>(
        `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
         VALUES ('reconciler.sweep', NULL, 'sweeper', 'reconciler.sweep.tick', ?, ?)`,
      )
      .run(ts, JSON.stringify({ closed, scanned, errors }));

    return { closed, scanned, errors };
  } catch (err) {
    opts.log?.warn?.({ err: String(err) }, "reconciler-sweep tick failed");
    return null;
  }
}

/** Schedules the reconciler sweep on a recurring interval. Returns a cancel function. */
export function startReconcilerSweeper(
  opts: ReconcilerSweepOpts,
  intervalMs: number = Number(process.env.PENUMBRA_RECONCILER_SWEEP_INTERVAL_MS) ||
    DEFAULT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void runReconcilerSweepTick(opts);
  }, intervalMs);
  maybeUnref(timer);
  return () => {
    clearInterval(timer);
  };
}
