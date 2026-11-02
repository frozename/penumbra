import type { HandoffRow, LeftDispatchedEvent, Services } from "@penumbra/core";

import {
  countProviderInFlight,
  listCappedProviders,
  listCappedSeats,
  resolveProviderConcurrencyDecision,
  resolveProviderSeatNames,
  resolveSeatConcurrencyDecision,
} from "./provider-concurrency.js";

export type ReofferCause = "left_dispatched" | "sweep";
export type ReofferSkipReason = "no_cap" | "still_at_cap" | "nothing_waiting" | "error";
export interface ReofferSummary {
  provider: string | null;
  // #257: set only on seat-scoped re-offers; provider-scoped summaries omit it.
  seat?: string;
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
  | {
      skipped: ReofferSkipReason;
      provider: string | null;
      seat?: string;
      cause: ReofferCause;
      err?: string;
    };
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
  provider: string | null;
  // #257: non-null marks a seat-scoped re-offer whose seatNames is that seat alone.
  seat: string | null;
  seatNames: string[];
  max_in_flight: number;
  cause: ReofferCause;
  freed_by: string | null;
  to_status: string | null;
  // Rows a sibling pass in the same tick already re-offered must not be emitted twice.
  excludeIds?: ReadonlySet<string>;
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
    const providerCaps = Array.isArray(this.services.providerQuotas)
      ? listCappedProviders(this.services)
      : [];
    if (providerCaps.length === 0 && listCappedSeats(this.services).length === 0)
      return { skipped: "no_cap", provider: null, cause: "left_dispatched" };
    const reoffered = new Set<string>();
    let outcome = this.providerLeftDispatchPass(evt, reoffered);
    const seatOutcome = this.seatLeftDispatchPass(evt, reoffered);
    if ((outcome === null || "skipped" in outcome) && seatOutcome !== null) outcome = seatOutcome;
    return outcome ?? { skipped: "no_cap", provider: null, cause: "left_dispatched" };
  }

  private providerLeftDispatchPass(
    evt: LeftDispatchedEvent,
    reoffered: Set<string>,
  ): ReofferOutcome | null {
    const decision = resolveProviderConcurrencyDecision(this.services, { to_agent: evt.to_agent });
    if (!decision) {
      this.services.log.debug(
        { handoff_id: evt.handoff_id, to_agent: evt.to_agent, to_status: evt.to_status },
        "provider capacity re-offer: seat not capped",
      );
      return null;
    }
    const outcome = this.reofferForCap({
      provider: decision.provider,
      seat: null,
      seatNames: decision.providerSeatNames,
      max_in_flight: decision.max_in_flight,
      cause: "left_dispatched",
      freed_by: evt.handoff_id,
      to_status: evt.to_status,
    });
    if (!("skipped" in outcome)) for (const id of outcome.reoffered) reoffered.add(id);
    return outcome;
  }

  // #257: a freed dispatch also releases the seat's own cap; rows held only by
  // that seat cap get their own re-offer pass scoped to the one seat.
  private seatLeftDispatchPass(
    evt: LeftDispatchedEvent,
    reoffered: Set<string>,
  ): ReofferOutcome | null {
    const decision = resolveSeatConcurrencyDecision(this.services, { to_agent: evt.to_agent });
    if (!decision) return null;
    return this.reofferForCap({
      provider: decision.provider,
      seat: decision.seat,
      seatNames: [decision.seat],
      max_in_flight: decision.max_in_flight,
      cause: "left_dispatched",
      freed_by: evt.handoff_id,
      to_status: evt.to_status,
      excludeIds: reoffered,
    });
  }

  sweep(): ReofferOutcome[] {
    const providerCaps = Array.isArray(this.services.providerQuotas)
      ? listCappedProviders(this.services)
      : [];
    const seatCaps = listCappedSeats(this.services);
    if (providerCaps.length === 0 && seatCaps.length === 0) return [];
    const tracker = {
      outcomes: [] as ReofferOutcome[],
      entries: [] as { provider: string | null; seat: string | null; ids: string[] }[],
      reoffered: new Set<string>(),
    };
    this.sweepProviderCaps(providerCaps, tracker);
    this.sweepSeatCaps(seatCaps, tracker);
    this.updateStarvation(tracker.entries);
    return tracker.outcomes;
  }

  private sweepProviderCaps(
    caps: { provider: string; max_in_flight: number }[],
    tracker: {
      outcomes: ReofferOutcome[];
      entries: { provider: string | null; seat: string | null; ids: string[] }[];
      reoffered: Set<string>;
    },
  ): void {
    for (const cap of caps) {
      const seatNames = resolveProviderSeatNames(this.services, cap.provider);
      if (seatNames.length === 0) {
        this.services.log.warn(
          { provider: cap.provider, max_in_flight: cap.max_in_flight },
          "provider capacity re-offer: capped provider has no seats",
        );
        tracker.outcomes.push({ skipped: "no_cap", provider: cap.provider, cause: "sweep" });
        continue;
      }
      this.trackSweep(
        this.reofferForCap({
          provider: cap.provider,
          seat: null,
          seatNames,
          max_in_flight: cap.max_in_flight,
          cause: "sweep",
          freed_by: null,
          to_status: null,
        }),
        { provider: cap.provider, seat: null },
        tracker,
      );
    }
  }

  private sweepSeatCaps(
    caps: { seat: string; provider: string | null; max_in_flight: number }[],
    tracker: {
      outcomes: ReofferOutcome[];
      entries: { provider: string | null; seat: string | null; ids: string[] }[];
      reoffered: Set<string>;
    },
  ): void {
    for (const cap of caps) {
      this.trackSweep(
        this.reofferForCap({
          provider: cap.provider,
          seat: cap.seat,
          seatNames: [cap.seat],
          max_in_flight: cap.max_in_flight,
          cause: "sweep",
          freed_by: null,
          to_status: null,
          excludeIds: tracker.reoffered,
        }),
        { provider: cap.provider, seat: cap.seat },
        tracker,
      );
    }
  }

  private trackSweep(
    outcome: ReofferOutcome,
    scope: { provider: string | null; seat: string | null },
    tracker: {
      outcomes: ReofferOutcome[];
      entries: { provider: string | null; seat: string | null; ids: string[] }[];
      reoffered: Set<string>;
    },
  ): void {
    tracker.outcomes.push(outcome);
    if ("skipped" in outcome) return;
    for (const id of outcome.reoffered) tracker.reoffered.add(id);
    tracker.entries.push({ ...scope, ids: outcome.reoffered });
  }

  private capScope(input: ReofferInput): { provider: string | null; seat?: string } {
    return input.seat === null
      ? { provider: input.provider }
      : { provider: input.provider, seat: input.seat };
  }

  private reofferForCap(input: ReofferInput): ReofferOutcome {
    try {
      const in_flight_count = countProviderInFlight(this.services, input.seatNames);
      const free = input.max_in_flight - in_flight_count;
      const waiting = this.services.handoffReader.countClaimableForSeats(input.seatNames);
      const base = {
        ...this.capScope(input),
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
      const limit = Math.min(free + 1, this.maxRowsPerReoffer);
      const rows = this.services.handoffReader
        .listClaimableForSeats({
          seatNames: input.seatNames,
          limit: Math.min(limit + (input.excludeIds?.size ?? 0), this.maxRowsPerReoffer),
        })
        .filter((row) => !input.excludeIds?.has(row.handoff_id))
        .slice(0, limit);
      const summary = { ...base, reoffered: rows.map((row) => row.handoff_id) };
      this.emitRows(input, rows, summary);
      this.logOutcome(input, summary);
      return summary;
    } catch (err) {
      this.services.log.warn(
        {
          ...this.capScope(input),
          cause: input.cause,
          freed_by: input.freed_by,
          err: String(err),
        },
        "provider capacity re-offer failed",
      );
      return {
        skipped: "error",
        ...this.capScope(input),
        cause: input.cause,
        err: String(err),
      };
    }
  }

  private skip(
    input: ReofferInput,
    summary: ReofferSummary,
    skipped: ReofferSkipReason,
  ): ReofferOutcome {
    this.logOutcome(input, summary);
    return { skipped, ...this.capScope(input), cause: input.cause };
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
          ...this.capScope(input),
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
        ...this.capScope(input),
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

  private updateStarvation(
    entries: { provider: string | null; seat: string | null; ids: string[] }[],
  ): void {
    const active = new Set(entries.flatMap((entry) => entry.ids));
    for (const id of [...this.reofferedSweeps.keys()])
      if (!active.has(id)) this.reofferedSweeps.delete(id);
    for (const entry of entries) {
      const scope =
        entry.seat === null
          ? { provider: entry.provider }
          : { provider: entry.provider, seat: entry.seat };
      for (const id of entry.ids) {
        const consecutive_sweeps = (this.reofferedSweeps.get(id) ?? 0) + 1;
        this.reofferedSweeps.set(id, consecutive_sweeps);
        if (consecutive_sweeps >= this.starvationSweeps) {
          this.services.log.warn(
            { ...scope, handoff_id: id, consecutive_sweeps },
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
