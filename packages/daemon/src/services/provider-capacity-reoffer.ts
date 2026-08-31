import type { HandoffRow, LeftDispatchedEvent, Services } from "@penumbra/core";

import {
  countProviderInFlight,
  listCappedProviders,
  resolveProviderConcurrencyDecision,
  resolveProviderSeatNames,
} from "./provider-concurrency.js";

export type ReofferCause = "left_dispatched" | "sweep";
export type ReofferSkipReason = "no_cap" | "still_at_cap" | "nothing_waiting" | "error";
export interface ReofferSummary {
  provider: string;
  cause: ReofferCause;
  freed_by: string | null;
  to_status: string | null;
  max_in_flight: number;
  in_flight_count: number;
  free: number;
  waiting: number;
  reoffered: string[];
}
export type ReofferOutcome =
  | ReofferSummary
  | { skipped: ReofferSkipReason; provider: string | null; cause: ReofferCause; err?: string };
export type ReofferServices = Pick<
  Services,
  | "db"
  | "log"
  | "clock"
  | "handoffEvents"
  | "handoffTransitions"
  | "handoffReader"
  | "dispatchEventLog"
  | "agentchatConfig"
  | "providerQuotas"
>;
export interface ProviderCapacityReoffer {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  onLeftDispatched(evt: LeftDispatchedEvent): ReofferOutcome;
  sweep(): ReofferOutcome[];
}

export const DEFAULT_MAX_ROWS_PER_REOFFER = 16;
export const DEFAULT_STARVATION_SWEEPS = 3;

interface ReofferInput {
  provider: string;
  seatNames: string[];
  max_in_flight: number;
  cause: ReofferCause;
  freed_by: string | null;
  to_status: string | null;
}

class ProviderCapacityReofferImpl implements ProviderCapacityReoffer {
  private unsubscribe: (() => void) | null = null;
  private readonly reofferedSweeps = new Map<string, number>();
  private readonly maxRowsPerReoffer: number;
  private readonly starvationSweeps: number;

  constructor(
    private readonly services: ReofferServices,
    opts: { maxRowsPerReoffer?: number; starvationSweeps?: number },
  ) {
    this.maxRowsPerReoffer = opts.maxRowsPerReoffer ?? DEFAULT_MAX_ROWS_PER_REOFFER;
    this.starvationSweeps = opts.starvationSweeps ?? DEFAULT_STARVATION_SWEEPS;
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

  onLeftDispatched(evt: LeftDispatchedEvent): ReofferOutcome {
    if (
      !Array.isArray(this.services.providerQuotas) ||
      listCappedProviders(this.services).length === 0
    )
      return { skipped: "no_cap", provider: null, cause: "left_dispatched" };
    const decision = resolveProviderConcurrencyDecision(this.services, { to_agent: evt.to_agent });
    if (!decision) {
      this.services.log.debug(
        { handoff_id: evt.handoff_id, to_agent: evt.to_agent, to_status: evt.to_status },
        "provider capacity re-offer: seat not capped",
      );
      return { skipped: "no_cap", provider: null, cause: "left_dispatched" };
    }
    return this.reofferForProvider({
      provider: decision.provider,
      seatNames: decision.providerSeatNames,
      max_in_flight: decision.max_in_flight,
      cause: "left_dispatched",
      freed_by: evt.handoff_id,
      to_status: evt.to_status,
    });
  }

  sweep(): ReofferOutcome[] {
    if (
      !Array.isArray(this.services.providerQuotas) ||
      listCappedProviders(this.services).length === 0
    )
      return [];
    const outcomes: ReofferOutcome[] = [];
    const sweepReoffered: { provider: string; ids: string[] }[] = [];
    for (const cap of listCappedProviders(this.services)) {
      const seatNames = resolveProviderSeatNames(this.services, cap.provider);
      if (seatNames.length === 0) {
        this.services.log.warn(
          { provider: cap.provider, max_in_flight: cap.max_in_flight },
          "provider capacity re-offer: capped provider has no seats",
        );
        outcomes.push({ skipped: "no_cap", provider: cap.provider, cause: "sweep" });
        continue;
      }
      const outcome = this.reofferForProvider({
        provider: cap.provider,
        seatNames,
        max_in_flight: cap.max_in_flight,
        cause: "sweep",
        freed_by: null,
        to_status: null,
      });
      outcomes.push(outcome);
      if (!("skipped" in outcome))
        sweepReoffered.push({ provider: cap.provider, ids: outcome.reoffered });
    }
    this.updateStarvation(sweepReoffered);
    return outcomes;
  }

  private reofferForProvider(input: ReofferInput): ReofferOutcome {
    try {
      const in_flight_count = countProviderInFlight(this.services, input.seatNames);
      const free = input.max_in_flight - in_flight_count;
      const waiting = this.services.handoffReader.countClaimableForSeats(input.seatNames);
      const base = {
        provider: input.provider,
        cause: input.cause,
        freed_by: input.freed_by,
        to_status: input.to_status,
        max_in_flight: input.max_in_flight,
        in_flight_count,
        free,
        waiting,
      };
      if (free <= 0) return this.skip(input, { ...base, reoffered: [] }, "still_at_cap");
      if (waiting === 0) return this.skip(input, { ...base, reoffered: [] }, "nothing_waiting");
      const rows = this.services.handoffReader.listClaimableForSeats({
        seatNames: input.seatNames,
        limit: Math.min(free + 1, this.maxRowsPerReoffer),
      });
      const summary = { ...base, reoffered: rows.map((row) => row.handoff_id) };
      this.emitRows(input, rows, summary);
      this.logOutcome(input, summary);
      return summary;
    } catch (err) {
      this.services.log.warn(
        {
          provider: input.provider,
          cause: input.cause,
          freed_by: input.freed_by,
          err: String(err),
        },
        "provider capacity re-offer failed",
      );
      return { skipped: "error", provider: input.provider, cause: input.cause, err: String(err) };
    }
  }

  private skip(
    input: ReofferInput,
    summary: ReofferSummary,
    skipped: ReofferSkipReason,
  ): ReofferOutcome {
    this.logOutcome(input, summary);
    return { skipped, provider: input.provider, cause: input.cause };
  }

  private emitRows(input: ReofferInput, rows: HandoffRow[], summary: ReofferSummary): void {
    const ts = this.services.clock().toISOString();
    for (const row of rows) {
      this.services.dispatchEventLog.record({
        handoff_id: row.handoff_id,
        worker_id: null,
        source: "daemon",
        kind: "claim.reoffer",
        ts,
        meta: {
          provider: input.provider,
          cause: input.cause,
          freed_by: input.freed_by,
          to_status: input.to_status,
          free: summary.free,
          waiting: summary.waiting,
          in_flight_count: summary.in_flight_count,
          max_in_flight: summary.max_in_flight,
        },
      });
      this.services.handoffEvents.emit(row);
    }
  }

  private logOutcome(input: ReofferInput, summary: ReofferSummary): void {
    this.services.log.info(
      {
        provider: input.provider,
        cause: input.cause,
        freed_by: input.freed_by,
        to_status: input.to_status,
        max_in_flight: summary.max_in_flight,
        in_flight_count: summary.in_flight_count,
        free: summary.free,
        waiting: summary.waiting,
        reoffered: summary.reoffered,
      },
      "provider capacity re-offer",
    );
  }

  private updateStarvation(entries: { provider: string; ids: string[] }[]): void {
    const active = new Set(entries.flatMap((entry) => entry.ids));
    for (const id of [...this.reofferedSweeps.keys()])
      if (!active.has(id)) this.reofferedSweeps.delete(id);
    for (const entry of entries) {
      for (const id of entry.ids) {
        const consecutive_sweeps = (this.reofferedSweeps.get(id) ?? 0) + 1;
        this.reofferedSweeps.set(id, consecutive_sweeps);
        if (consecutive_sweeps >= this.starvationSweeps) {
          this.services.log.warn(
            { provider: entry.provider, handoff_id: id, consecutive_sweeps },
            "provider capacity re-offer: handoff re-offered repeatedly without a claim",
          );
        }
      }
    }
  }
}

/**
 * HandoffWriter emits left_dispatched synchronously when no transaction is open, including inside its own markFailed wrapper. Inside an outer db.transaction (sweepers/stale-handoff.ts, services/orphan-handoff-recovery.ts, workers/handoff-sweeper.ts), core defers the emit to a microtask and re-checks the row: if it is still dispatched at flush, the event is dropped; otherwise it is emitted after commit.
 * The SSE write is an in-memory enqueue, so no worker claim is processed before the current synchronous call stack completes. The bus swallows listener throws, so a re-offer can never break a completion/failure/requeue/expiry.
 */
export function createProviderCapacityReoffer(opts: {
  services: ReofferServices;
  maxRowsPerReoffer?: number;
  starvationSweeps?: number;
}): ProviderCapacityReoffer {
  return new ProviderCapacityReofferImpl(opts.services, opts);
}
