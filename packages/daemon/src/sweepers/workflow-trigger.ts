import type { Registry, StateMetrics } from "@penumbra/workflows";
import type { Database } from "bun:sqlite";

import { evaluateStateThresholds } from "@penumbra/workflows";

type WorkflowRegistryLike = {
  list(): readonly unknown[];
  findByTrigger(event: unknown): readonly unknown[];
  getEntry(name: string): unknown;
  readonly errors: readonly unknown[];
};

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

export interface WorkflowTriggerSweeperOpts {
  registry: WorkflowRegistryLike;
  computeMetrics: (now: () => Date) => StateMetrics;
  runWorkflow: (name: string) => Promise<void>;
  /** Debounce applied to a fresh crossing. Default 5 min. */
  cooldownMs?: number;
  /** Re-arm interval for a threshold that never uncrosses. Default 6 h. */
  rearmMs?: number;
  /** Durable seed for lastFired, read once when the sweeper starts. */
  seedLastFired?: () => Map<string, number>;
  log?: { warn?: (obj: unknown, msg?: string) => void };
}

export interface WorkflowTriggerSweepState {
  lastFired: Map<string, number>;
  wasMatched?: Set<string>;
}

export interface SweepTickResult {
  fired: string[];
  matched: string[];
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_REARM_MS = 6 * 60 * 60 * 1000;
const DEFAULT_STALE_LAST_FIRED_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60_000;

function evictStaleLastFired(lastFired: Map<string, number>, staleBefore: number): void {
  for (const [name, last] of lastFired) {
    if (last <= staleBefore) lastFired.delete(name);
  }
}

export function readWorkflowLastFired(db: Database): Map<string, number> {
  const seed = new Map<string, number>();
  try {
    const rows = db
      .query<{ name: unknown; ts: unknown }, []>(
        `SELECT CASE WHEN json_valid(payload_json) THEN
                  CASE WHEN json_type(payload_json, '$.workflow_name') = 'text'
                    THEN json_extract(payload_json, '$.workflow_name') END
                END AS name,
                ts
           FROM t0_events
          WHERE event_type = 'workflow.outcome'`,
      )
      .all();
    for (const row of rows) {
      if (typeof row.name !== "string" || row.name.trim().length === 0) continue;
      if (typeof row.ts !== "string") continue;
      const timestamp = Date.parse(row.ts);
      if (!Number.isFinite(timestamp)) continue;
      const previous = seed.get(row.name);
      if (previous === undefined || timestamp > previous) seed.set(row.name, timestamp);
    }
  } catch {
    return new Map<string, number>();
  }
  return seed;
}

/**
 * Runs one tick: compute metrics, find matched workflows via the trigger evaluator,
 * and fire on a fresh crossing or after a continuous-crossing re-arm interval.
 */
export async function runWorkflowTriggerSweep(
  opts: WorkflowTriggerSweeperOpts,
  state: WorkflowTriggerSweepState,
  now: () => Date,
): Promise<SweepTickResult> {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const rearmMs = opts.rearmMs ?? DEFAULT_REARM_MS;
  const metrics = opts.computeMetrics(now);
  const matchedSpecs = evaluateStateThresholds(opts.registry as unknown as Registry, metrics);
  const matched = matchedSpecs.map((s) => s.name);

  const nowMs = now().getTime();
  evictStaleLastFired(state.lastFired, nowMs - DEFAULT_STALE_LAST_FIRED_MS);

  const wasMatched = (state.wasMatched ??= new Set<string>());
  const fired: string[] = [];
  for (const name of matched) {
    const last = state.lastFired.get(name);
    if (last !== undefined && nowMs - last <= cooldownMs) continue;
    if (wasMatched.has(name) && last !== undefined && nowMs - last <= rearmMs) continue;
    state.lastFired.set(name, nowMs);
    fired.push(name);
  }
  state.wasMatched = new Set(matched);

  for (const name of fired) {
    try {
      await opts.runWorkflow(name);
    } catch (err) {
      opts.log?.warn?.({ err: String(err), workflow: name }, "workflow-trigger sweep run failed");
    }
  }

  return { fired, matched };
}

/** Schedules the sweep on a recurring interval. Returns a cancel function. */
export function startWorkflowTriggerSweeper(
  opts: WorkflowTriggerSweeperOpts,
  intervalMs = DEFAULT_INTERVAL_MS,
  now: () => Date = () => new Date(),
): () => void {
  const state: WorkflowTriggerSweepState = {
    lastFired: opts.seedLastFired?.() ?? new Map<string, number>(),
    wasMatched: new Set<string>(),
  };
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) {
      opts.log?.warn?.(
        { event: "workflow_trigger.tick_skipped" },
        "workflow-trigger sweep still running; skipping tick",
      );
      return;
    }
    inFlight = true;
    void runWorkflowTriggerSweep(opts, state, now)
      .catch((err: unknown) => {
        opts.log?.warn?.({ err: String(err) }, "workflow-trigger sweep tick failed");
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  maybeUnref(timer);
  return () => {
    clearInterval(timer);
  };
}
