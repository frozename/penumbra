import type { Registry, StateMetrics } from "@penumbra/workflows";
import { evaluateStateThresholds } from "@penumbra/workflows";

type WorkflowRegistryLike = {
  list(): ReadonlyArray<unknown>;
  findByTrigger(event: unknown): ReadonlyArray<unknown>;
  getEntry(name: string): unknown;
  readonly errors: ReadonlyArray<unknown>;
};

export interface WorkflowTriggerSweeperOpts {
  registry: WorkflowRegistryLike;
  computeMetrics: (now: () => Date) => StateMetrics;
  runWorkflow: (name: string) => Promise<void>;
  /** Cooldown per workflow_name to prevent re-firing while threshold stays crossed. Default 5 min. */
  cooldownMs?: number;
  log?: { warn?: (obj: unknown, msg?: string) => void };
}

export interface SweepTickResult {
  fired: string[];
  matched: string[];
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_STALE_LAST_FIRED_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Runs one tick: compute metrics, find matched workflows via the trigger evaluator,
 * fire any whose cooldown has elapsed. Idempotent across concurrent calls thanks to
 * the in-memory cooldown map. Exposed for tests.
 */
export async function runWorkflowTriggerSweep(
  opts: WorkflowTriggerSweeperOpts,
  state: { lastFired: Map<string, number> },
  now: () => Date,
): Promise<SweepTickResult> {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const metrics = opts.computeMetrics(now);
  const matchedSpecs = evaluateStateThresholds(opts.registry as unknown as Registry, metrics);
  const matched = matchedSpecs.map((s) => s.name);

  const nowMs = now().getTime();
  const staleBefore = nowMs - DEFAULT_STALE_LAST_FIRED_MS;
  for (const [name, last] of state.lastFired) {
    if (last <= staleBefore) {
      state.lastFired.delete(name);
    }
  }

  const fired: string[] = [];
  for (const name of matched) {
    const last = state.lastFired.get(name);
    if (last !== undefined && nowMs - last <= cooldownMs) continue;
    state.lastFired.set(name, nowMs);
    fired.push(name);
  }

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
  const state = { lastFired: new Map<string, number>() };
  const timer = setInterval(() => {
    runWorkflowTriggerSweep(opts, state, now).catch((err) => {
      opts.log?.warn?.({ err: String(err) }, "workflow-trigger sweep tick failed");
    });
  }, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  return () => clearInterval(timer);
}
