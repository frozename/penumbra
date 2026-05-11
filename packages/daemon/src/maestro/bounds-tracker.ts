import type { Database } from 'bun:sqlite';
import type { BoundsAxis, CapCheckWarn, MaestroSessionRecord } from '@penumbra/core';
import { MaestroSessionWriter } from '@penumbra/core';
import { rollupCostForChain } from './cost-rollup.js';

export interface CreateBoundsTrackerOpts {
  db: Database;
  sessions: MaestroSessionWriter;
  rollupCostForChain?: (db: Database, chain_handoff_id: string) => number;
  intervalMs?: number;
  warnThreshold?: number;
  now?: () => number;
  kind?: 'maestro' | 'long_lived_tick';
  log?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
  onSoftWarn: (session: MaestroSessionRecord, kind: 'maestro' | 'long_lived_tick') => void;
  onHardKill: (session: MaestroSessionRecord, axis: BoundsAxis, kind: 'maestro' | 'long_lived_tick') => void;
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
  const rollupCost = opts.rollupCostForChain ?? rollupCostForChain;
  const kind = opts.kind ?? 'maestro';

  let timer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    const live = opts.sessions.listLive();
    opts.log?.info({ session_count: live.length }, 'maestro bounds-tracker tick');
    for (const session of live) {
      if (!session.chain_handoff_id) {
        continue;
      }
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
        opts.onHardKill(session, pressureAxis.axis, kind);
        continue;
      }

      const wallPct = percent(now() - session.started_at, session.wall_clock_budget_ms);

      const costCents = rollupCost(opts.db, session.chain_handoff_id);
      opts.sessions.bumpCostConsumed(session.task_id, costCents);
      const freshSession = opts.sessions.get(session.task_id);
      if (!freshSession) {
        continue;
      }

      const costPct = freshSession.cost_budget_cents === 0
        ? 1
        : percent(costCents, freshSession.cost_budget_cents);

      const subPct = percent(freshSession.sub_dispatches_consumed, freshSession.sub_dispatch_budget);
      const pct = Math.max(wallPct, costPct, subPct);

      if (pct >= 1) {
        opts.onHardKill(freshSession, firstExceededAxis(wallPct, costPct, subPct), kind);
        continue;
      }

      if (pct >= warnThreshold && freshSession.soft_warned_at === null) {
        try {
          opts.onSoftWarn(freshSession, kind);
          opts.sessions.markSoftWarned(freshSession.task_id);
        } catch (error) {
          opts.log?.warn({ task_id: freshSession.task_id, err: error instanceof Error ? error.message : String(error) }, 'maestro bounds-tracker soft warning failed');
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
