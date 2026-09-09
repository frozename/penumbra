import type { HandoffRow, LeftDispatchedEvent, Services } from "@penumbra/core";

export type ClaimSpreadReofferCause = "left_dispatched" | "sweep";
export type ClaimSpreadReofferSkipReason = "not_workflow" | "nothing_waiting" | "error";

export interface ClaimSpreadReofferSummary {
  workflow_run_id: string;
  cause: ClaimSpreadReofferCause;
  freed_by: string | null;
  waiting: number;
  reoffered: string[];
}

export type ClaimSpreadReofferOutcome =
  | ClaimSpreadReofferSummary
  | {
      skipped: ClaimSpreadReofferSkipReason;
      workflow_run_id: string | null;
      cause: ClaimSpreadReofferCause;
      err?: string;
    };

export type ClaimSpreadReofferServices = Pick<
  Services,
  | "db"
  | "log"
  | "clock"
  | "handoffEvents"
  | "handoffTransitions"
  | "handoffReader"
  | "dispatchEventLog"
>;

export interface ClaimSpreadReoffer {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  onLeftDispatched(evt: LeftDispatchedEvent): ClaimSpreadReofferOutcome;
  sweep(): ClaimSpreadReofferOutcome[];
}

export const DEFAULT_MAX_ROWS_PER_SPREAD_REOFFER = 16;
export const DEFAULT_SPREAD_STARVATION_SWEEPS = 3;

class ClaimSpreadReofferImpl implements ClaimSpreadReoffer {
  private unsubscribe: (() => void) | null = null;
  private readonly reofferedSweeps = new Map<string, number>();
  private readonly maxRowsPerReoffer: number;
  private readonly starvationSweeps: number;

  constructor(
    private readonly services: ClaimSpreadReofferServices,
    opts: { maxRowsPerReoffer?: number; starvationSweeps?: number },
  ) {
    this.maxRowsPerReoffer = opts.maxRowsPerReoffer ?? DEFAULT_MAX_ROWS_PER_SPREAD_REOFFER;
    this.starvationSweeps = opts.starvationSweeps ?? DEFAULT_SPREAD_STARVATION_SWEEPS;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.services.handoffTransitions.subscribe((evt) => {
      this.onLeftDispatched(evt);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  tick(): Promise<void> {
    this.sweep();
    return Promise.resolve();
  }

  onLeftDispatched(evt: LeftDispatchedEvent): ClaimSpreadReofferOutcome {
    const row = this.services.db
      .query<
        { dispatch_kind: string | null; workflow_run_id: string | null },
        [string]
      >("SELECT dispatch_kind, workflow_run_id FROM handoffs WHERE handoff_id=?")
      .get(evt.handoff_id);
    if (row?.dispatch_kind !== "workflow" || !row.workflow_run_id)
      return { skipped: "not_workflow", workflow_run_id: null, cause: "left_dispatched" };
    return this.reofferForRun(row.workflow_run_id, "left_dispatched", evt.handoff_id);
  }

  sweep(): ClaimSpreadReofferOutcome[] {
    const outcomes: ClaimSpreadReofferOutcome[] = [];
    const sweepReoffered: string[] = [];
    for (const workflow_run_id of this.listWaitingRunIds()) {
      const outcome = this.reofferForRun(workflow_run_id, "sweep", null);
      outcomes.push(outcome);
      if (!("skipped" in outcome)) sweepReoffered.push(...outcome.reoffered);
    }
    this.updateStarvation(sweepReoffered);
    return outcomes;
  }

  private listWaitingRunIds(): string[] {
    return this.services.db
      .query<{ workflow_run_id: string }, []>(
        `SELECT DISTINCT workflow_run_id
           FROM handoffs
          WHERE dispatch_kind='workflow'
            AND workflow_run_id IS NOT NULL
            AND status IN ('approved','redirected')
            AND dispatch_attempts < max_dispatch_attempts`,
      )
      .all()
      .map((row) => row.workflow_run_id);
  }

  private listWaitingRows(workflow_run_id: string): HandoffRow[] {
    const ids = this.services.db
      .query<{ handoff_id: string }, [string, number]>(
        `SELECT handoff_id
           FROM handoffs
          WHERE dispatch_kind='workflow'
            AND workflow_run_id=?
            AND status IN ('approved','redirected')
            AND dispatch_attempts < max_dispatch_attempts
          ORDER BY ts ASC, handoff_id ASC
          LIMIT ?`,
      )
      .all(workflow_run_id, this.maxRowsPerReoffer)
      .map((row) => row.handoff_id);
    const rows: HandoffRow[] = [];
    for (const id of ids) {
      const row = this.services.handoffReader.get(id);
      if (row) rows.push(row);
    }
    return rows;
  }

  private reofferForRun(
    workflow_run_id: string,
    cause: ClaimSpreadReofferCause,
    freed_by: string | null,
  ): ClaimSpreadReofferOutcome {
    try {
      const rows = this.listWaitingRows(workflow_run_id);
      if (rows.length === 0) return { skipped: "nothing_waiting", workflow_run_id, cause };
      const summary: ClaimSpreadReofferSummary = {
        workflow_run_id,
        cause,
        freed_by,
        waiting: rows.length,
        reoffered: rows.map((row) => row.handoff_id),
      };
      const ts = this.services.clock().toISOString();
      for (const row of rows) {
        this.services.dispatchEventLog.record({
          handoff_id: row.handoff_id,
          worker_id: null,
          source: "daemon",
          kind: "claim.reoffer",
          ts,
          meta: {
            cause: `workflow_spread:${cause}`,
            workflow_run_id,
            freed_by,
            waiting: summary.waiting,
          },
        });
        this.services.handoffEvents.emit(row);
      }
      this.services.log.info(
        { workflow_run_id, cause, freed_by, waiting: summary.waiting, reoffered: summary.reoffered },
        "claim spread re-offer",
      );
      return summary;
    } catch (err) {
      this.services.log.warn(
        { workflow_run_id, cause, freed_by, err: String(err) },
        "claim spread re-offer failed",
      );
      return { skipped: "error", workflow_run_id, cause, err: String(err) };
    }
  }

  private updateStarvation(ids: string[]): void {
    const active = new Set(ids);
    for (const id of [...this.reofferedSweeps.keys()])
      if (!active.has(id)) this.reofferedSweeps.delete(id);
    for (const id of ids) {
      const consecutive_sweeps = (this.reofferedSweeps.get(id) ?? 0) + 1;
      this.reofferedSweeps.set(id, consecutive_sweeps);
      if (consecutive_sweeps >= this.starvationSweeps) {
        this.services.log.warn(
          { handoff_id: id, consecutive_sweeps },
          "claim spread re-offer: handoff re-offered repeatedly without a claim",
        );
      }
    }
  }
}

/**
 * The claim spread cap (packages/daemon/src/routes/handoffs.ts:178-203) refuses a
 * fan-out sibling with a 409 the worker treats as retryable, dropping it from SSE
 * dedup (packages/agentchat/src/worker/dispatcher.ts:428). Its only other
 * re-discovery route is the poll loop, which is fully suppressed while SSE is alive
 * (packages/agentchat/src/worker/event-source.ts:157-158), so without this re-offer
 * the capped row strands at status='approved' until the SSE connection drops.
 */
export function createClaimSpreadReoffer(opts: {
  services: ClaimSpreadReofferServices;
  maxRowsPerReoffer?: number;
  starvationSweeps?: number;
}): ClaimSpreadReoffer {
  return new ClaimSpreadReofferImpl(opts.services, opts);
}
