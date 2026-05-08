import type { Database } from 'bun:sqlite';
import type { BoundsAxis, CapCheckWarn, MaestroSessionRecord } from '@penumbra/core';
import { MaestroSessionWriter } from '@penumbra/core';
import { rollupCostForChain } from './cost-rollup.js';

export interface CreateBoundsTrackerOpts {
  db: Database;
  sessions: MaestroSessionWriter;
  intervalMs?: number;
  warnThreshold?: number;
  now?: () => number;
  log?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
  onSoftWarn: (session: MaestroSessionRecord) => void;
  onHardKill: (session: MaestroSessionRecord, axis: BoundsAxis) => void;
  /**
   * Optional probe called every tick before axis evaluation. Returns a non-null
   * result when the session should be affected by a non-numeric pressure state.
   */
  evaluatePressure?: (session: MaestroSessionRecord) => { kind: 'warn'; outcome: CapCheckWarn } | { kind: 'refuse'; axis: BoundsAxis } | null;
  onPressureSoftWarn?: (session: MaestroSessionRecord, outcome: CapCheckWarn) => void;
}

function percent(consumed: number, budget: number): number {
  if (budget <= 0) return 1;
  return consumed / budget;
}

function firstExceededAxis(wallPct: number, costPct: number, subPct: number): BoundsAxis {
  if (wallPct >= 1) return 'wall_clock';
  if (costPct >= 1) return 'cost';
  if (subPct >= 1) return 'sub_dispatches';
  return 'wall_clock';
}

export function createBoundsTracker(opts: CreateBoundsTrackerOpts): {
  start(): void;
  stop(): void;
  tick(): void;
} {
  const intervalMs = opts.intervalMs ?? 5_000;
  const warnThreshold = opts.warnThreshold ?? 0.8;
  const now = opts.now ?? Date.now;

  let timer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    const live = opts.sessions.listLive();
    opts.log?.info({ session_count: live.length }, 'maestro bounds-tracker tick');
    for (const session of live) {
      // Pressure backstop: fires every tick, independent of numeric budget axes.
      // Lets the tracker terminate a long-running maestro when its subscription
      // window crosses the cap mid-flight, even if wall_clock/cost/sub_dispatches
      // are all healthy.
      const pressureAxis = opts.evaluatePressure?.(session);
      if (pressureAxis?.kind === 'warn') {
        if (session.soft_warned_at === null) {
          try {
            opts.onPressureSoftWarn?.(session, pressureAxis.outcome);
            opts.sessions.markSoftWarned(session.task_id);
          } catch (error) {
            opts.log?.warn({ task_id: session.task_id, err: error instanceof Error ? error.message : String(error) }, 'maestro bounds-tracker pressure warning failed');
          }
        }
        continue;
      }
      if (pressureAxis?.kind === 'refuse') {
        opts.onHardKill(session, pressureAxis.axis);
        continue;
      }

      const wallPct = percent(now() - session.started_at, session.wall_clock_budget_ms);

      const costCents = rollupCostForChain(opts.db, session.chain_handoff_id);
      opts.sessions.bumpCostConsumed(session.task_id, costCents);
      const costPct = session.cost_budget_cents === 0
        ? 1
        : percent(costCents, session.cost_budget_cents);

      const subPct = percent(session.sub_dispatches_consumed, session.sub_dispatch_budget);
      const pct = Math.max(wallPct, costPct, subPct);

      if (pct >= 1) {
        opts.onHardKill(session, firstExceededAxis(wallPct, costPct, subPct));
        continue;
      }

      if (pct >= warnThreshold && session.soft_warned_at === null) {
        try {
          opts.onSoftWarn(session);
          opts.sessions.markSoftWarned(session.task_id);
        } catch (error) {
          opts.log?.warn({ task_id: session.task_id, err: error instanceof Error ? error.message : String(error) }, 'maestro bounds-tracker soft warning failed');
        }
      }
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      tick();
    }, intervalMs);
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    tick,
  };
}
