import { resolveProvider, type Services } from "@penumbra/core";

import { workerHeartbeatStaleMs } from "../routes/worker-profile-gate.js";

export interface ProviderConcurrencyDecision {
  provider: string;
  providerSeatNames: string[];
  max_in_flight: number;
  in_flight_count: number;
}

type ConcurrencyServices = Pick<Services, "db" | "agentchatConfig" | "providerQuotas"> &
  Partial<Pick<Services, "clock">>;

// Fallback bound only. A stale-swept session releases its slot when its worker posts
// dispatch.end or when that worker stops heartbeating. stdio-acp's prompt timeout is an
// idle timer (20 min default, re-armed by every session/update), so no wall bound matches
// a busy session; this caps the slot leak when a live worker never reports dispatch.end
// (e.g. it restarted under the same persisted worker_id).
export const STALE_SWEEP_DRAIN_MAX_HOLD_MS = 60 * 60_000;

// Driven by the sweeper's own dispatch.end rows (written in the same transaction as the
// force-fail, ts = resolved_at) through idx_dispatch_events_end_ts; CROSS JOIN pins that
// order so SQLite never scans every failed handoff. The worker is live while the heartbeat
// route has touched one of its tokens within workerHeartbeatStaleMs() (the same freshness
// test as countFreshEligibleWorkers); the row is durable, so the hold survives a daemon
// restart, unlike the watchdog's in-memory map. A NULL worker_id never matches a token.
// Params: max-hold cutoff ISO, the seat names, then the worker-liveness cutoff in ms.
export function sweeperDrainingCountSql(placeholders: string): string {
  return `SELECT COUNT(*) AS n
            FROM dispatch_events s
           CROSS JOIN handoffs h
           WHERE s.kind = 'dispatch.end'
             AND s.ts >= ?
             AND s.source = 'sweeper'
             AND h.handoff_id = s.handoff_id
             AND h.to_agent IN (${placeholders})
             AND h.status = 'failed'
             AND h.resolved_by = 'stale-handoff-sweeper'
             AND NOT EXISTS (
               SELECT 1 FROM dispatch_events w
                WHERE w.handoff_id = h.handoff_id
                  AND w.kind = 'dispatch.end'
                  AND w.source = 'worker'
             )
             AND EXISTS (
               SELECT 1 FROM worker_tokens t
                WHERE t.worker_id = h.worker_id
                  AND t.revoked_at IS NULL
                  AND t.last_seen_at >= ?
             )`;
}

export function sweeperDrainCutoffIso(now: Date): string {
  return new Date(now.getTime() - STALE_SWEEP_DRAIN_MAX_HOLD_MS).toISOString();
}

export function countProviderInFlight(
  services: ConcurrencyServices,
  providerSeatNames: string[],
): number {
  if (providerSeatNames.length === 0) return 0;
  const placeholders = providerSeatNames.map(() => "?").join(",");
  const dispatched = services.db
    .query<{ n: number }, string[]>(
      `SELECT COUNT(*) AS n
         FROM handoffs
        WHERE status='dispatched'
          AND to_agent IN (${placeholders})`,
    )
    .get(...providerSeatNames);
  const cutoffIso = sweeperDrainCutoffIso(services.clock?.() ?? new Date());
  const workerLiveSinceMs = Date.now() - workerHeartbeatStaleMs();
  const draining = services.db
    .query<{ n: number }, (string | number)[]>(sweeperDrainingCountSql(placeholders))
    .get(cutoffIso, ...providerSeatNames, workerLiveSinceMs);
  return (dispatched?.n ?? 0) + (draining?.n ?? 0);
}

export function resolveProviderConcurrencyDecision(
  services: ConcurrencyServices,
  handoff: { to_agent: string },
): ProviderConcurrencyDecision | null {
  const agentchatConfig = services.agentchatConfig;
  if (!agentchatConfig) return null;
  const agents = agentchatConfig.agents;
  if (!Array.isArray(agents)) return null;
  const handoffAgent = agents.find((agent) => agent.name === handoff.to_agent);
  if (!handoffAgent) return null;

  const provider = resolveProvider(handoffAgent);
  if (!provider) return null;

  const quota = Array.isArray(services.providerQuotas)
    ? services.providerQuotas.find(
        (entry) =>
          entry.provider === provider &&
          entry.model === undefined &&
          entry.max_in_flight !== undefined,
      )
    : undefined;
  if (quota?.max_in_flight === undefined) return null;

  const providerSeatNames = agents
    .filter((agent) => resolveProvider(agent) === provider)
    .map((agent) => agent.name);
  if (providerSeatNames.length === 0) return null;

  return {
    provider,
    providerSeatNames,
    max_in_flight: quota.max_in_flight,
    in_flight_count: countProviderInFlight(services, providerSeatNames),
  };
}

export function listCappedProviders(
  services: Pick<Services, "providerQuotas">,
): { provider: string; max_in_flight: number }[] {
  if (!Array.isArray(services.providerQuotas)) return [];
  return services.providerQuotas.flatMap((row) =>
    row.model === undefined && row.max_in_flight !== undefined
      ? [{ provider: row.provider, max_in_flight: row.max_in_flight }]
      : [],
  );
}

export function resolveProviderSeatNames(
  services: Pick<Services, "agentchatConfig">,
  provider: string,
): string[] {
  const agents = services.agentchatConfig?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.filter((agent) => resolveProvider(agent) === provider).map((agent) => agent.name);
}

export function recordProviderCapRefusal(
  services: Pick<Services, "db" | "log" | "clock" | "dispatchEventLog">,
  args: {
    handoff_id: string;
    worker_id: string;
    decision: ProviderConcurrencyDecision;
    path: "precheck" | "cas_loss";
  },
): void {
  try {
    services.log.info(
      {
        handoff_id: args.handoff_id,
        worker_id: args.worker_id,
        provider: args.decision.provider,
        max_in_flight: args.decision.max_in_flight,
        in_flight_count: args.decision.in_flight_count,
        path: args.path,
      },
      "claim refused: provider in-flight cap",
    );
    const shouldRecord =
      args.path === "cas_loss" ||
      !services.db
        .query<{ one: number }, [string]>(
          `SELECT 1 AS one
             FROM dispatch_events
            WHERE handoff_id=?
              AND kind='claim.provider_cap_refused'
            LIMIT 1`,
        )
        .get(args.handoff_id);
    if (!shouldRecord) return;
    services.dispatchEventLog.record({
      handoff_id: args.handoff_id,
      worker_id: args.worker_id,
      source: "daemon",
      kind: "claim.provider_cap_refused",
      ts: services.clock().toISOString(),
      meta: {
        provider: args.decision.provider,
        max_in_flight: args.decision.max_in_flight,
        in_flight_count: args.decision.in_flight_count,
        path: args.path,
      },
    });
  } catch {
    /* observability must not alter claim refusal behavior */
  }
}
