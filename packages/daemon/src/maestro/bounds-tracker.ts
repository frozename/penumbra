import type { Database } from 'bun:sqlite';
import type { BoundsAxis, MaestroSessionRecord } from '@penumbra/core';
import { MaestroSessionWriter } from '@penumbra/core';
import { rollupCostForChain } from './cost-rollup.js';

export interface CreateBoundsTrackerOpts {
  db: Database;
  sessions: MaestroSessionWriter;
  intervalMs?: number;
  warnThreshold?: number;
  now?: () => number;
  onSoftWarn: (session: MaestroSessionRecord) => void;
  onHardKill: (session: MaestroSessionRecord, axis: BoundsAxis) => void;
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
    for (const session of live) {
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
        opts.onSoftWarn(session);
        opts.sessions.markSoftWarned(session.task_id);
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
