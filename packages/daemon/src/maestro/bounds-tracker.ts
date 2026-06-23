import type { BoundsAxis, CapCheckWarn, MaestroSessionRecord } from "@penumbra/core";
import type { Database } from "bun:sqlite";

import { MaestroSessionWriter } from "@penumbra/core";

import { rollupCostForChain } from "./cost-rollup.js";

export interface CreateBoundsTrackerOpts {
  db: Database;
  sessions: MaestroSessionWriter;
  rollupCostForChain?: (db: Database, chain_handoff_id: string) => number;
  intervalMs?: number;
  warnThreshold?: number;
  now?: () => number;
  kind?: "maestro" | "long_lived_tick";
  log?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
  onSoftWarn: (session: MaestroSessionRecord, kind: "maestro" | "long_lived_tick") => void;
  onHardKill: (
    session: MaestroSessionRecord,
    axis: BoundsAxis,
    kind: "maestro" | "long_lived_tick",
  ) => void;
  /**
   * Optional probe called every tick before axis evaluation. Returns a non-null
   * result when the session should be affected by a non-numeric pressure state.
   */
  evaluatePressure?: (
    session: MaestroSessionRecord,
  ) => { kind: "warn"; outcome: CapCheckWarn } | { kind: "refuse"; axis: BoundsAxis } | null;
  onPressureSoftWarn?: (session: MaestroSessionRecord, outcome: CapCheckWarn) => void;
}

function percent(consumed: number, budget: number): number {
  if (budget <= 0) return 1;
  return consumed / budget;
}

function firstExceededAxis(wallPct: number, costPct: number, subPct: number): BoundsAxis {
  if (wallPct >= 1) return "wall_clock";
  if (costPct >= 1) return "cost";
  if (subPct >= 1) return "sub_dispatches";
  return "wall_clock";
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
  const kind = opts.kind ?? "maestro";

  let timer: ReturnType<typeof setInterval> | null = null;

  // Returns true when the pressure probe owned the session this tick.
  function handlePressureProbe(session: MaestroSessionRecord): boolean {
    const pressureAxis = opts.evaluatePressure?.(session);
    if (!pressureAxis) return false;
    if (pressureAxis.kind === "warn") {
      if (session.soft_warned_at !== null) return true;
      try {
        opts.onPressureSoftWarn?.(session, pressureAxis.outcome);
        opts.sessions.markSoftWarned(session.task_id);
      } catch (error) {
        opts.log?.warn(
          {
            task_id: session.task_id,
            err: error instanceof Error ? error.message : String(error),
          },
          "maestro bounds-tracker pressure warning failed",
        );
      }
      return true;
    }
    opts.onHardKill(session, pressureAxis.axis, kind);
    return true;
  }

  function emitSoftWarn(session: MaestroSessionRecord): void {
    try {
      opts.onSoftWarn(session, kind);
      opts.sessions.markSoftWarned(session.task_id);
    } catch (error) {
      opts.log?.warn(
        {
          task_id: session.task_id,
          err: error instanceof Error ? error.message : String(error),
        },
        "maestro bounds-tracker soft warning failed",
      );
    }
  }

  function evaluateNumericAxes(session: MaestroSessionRecord & { chain_handoff_id: string }): void {
    const wallPct = percent(now() - session.started_at, session.wall_clock_budget_ms);
    const costCents = rollupCost(opts.db, session.chain_handoff_id);
    opts.sessions.bumpCostConsumed(session.task_id, costCents);
    const freshSession = opts.sessions.get(session.task_id);
    if (!freshSession) return;

    const costPct =
      freshSession.cost_budget_cents === 0 ? 1 : percent(costCents, freshSession.cost_budget_cents);
    const subPct = percent(freshSession.sub_dispatches_consumed, freshSession.sub_dispatch_budget);
    const pct = Math.max(wallPct, costPct, subPct);

    if (pct >= 1) {
      opts.onHardKill(freshSession, firstExceededAxis(wallPct, costPct, subPct), kind);
      return;
    }

    if (pct >= warnThreshold && freshSession.soft_warned_at === null) {
      emitSoftWarn(freshSession);
    }
  }

  function tick(): void {
    const live = opts.sessions.listLive();
    opts.log?.info({ session_count: live.length }, "maestro bounds-tracker tick");
    for (const session of live) {
      const chainHandoffId = session.chain_handoff_id;
      if (!chainHandoffId) continue;
      // Pressure backstop fires every tick, independent of numeric budget axes,
      // so a long-running maestro is terminated when its subscription window
      // crosses the cap mid-flight even if numeric axes are healthy.
      if (handlePressureProbe(session)) continue;
      evaluateNumericAxes({ ...session, chain_handoff_id: chainHandoffId });
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
