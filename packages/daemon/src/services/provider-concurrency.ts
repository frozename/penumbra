import { resolveProvider, type Services } from "@penumbra/core";

export interface ProviderConcurrencyDecision {
  provider: string;
  providerSeatNames: string[];
  max_in_flight: number;
  in_flight_count: number;
}

type ConcurrencyServices = Pick<Services, "db" | "agentchatConfig" | "providerQuotas"> &
  Partial<Pick<Services, "clock">>;

// Matches the ACP prompt timeout; bounds a worker that never reports dispatch.end.
export const STALE_SWEEP_DRAIN_GRACE_MS = 15 * 60_000;

// alias h, exactly one positional param: the resolved_at cutoff ISO
export const SWEEPER_DRAINING_SQL = `(h.status='failed' AND h.resolved_by='stale-handoff-sweeper' AND h.worker_id IS NOT NULL AND h.resolved_at >= ? AND NOT EXISTS (SELECT 1 FROM dispatch_events de WHERE de.handoff_id = h.handoff_id AND de.kind = 'dispatch.end' AND de.source = 'worker'))`;

export function sweeperDrainCutoffIso(now: Date): string {
  return new Date(now.getTime() - STALE_SWEEP_DRAIN_GRACE_MS).toISOString();
}

export function countProviderInFlight(
  services: ConcurrencyServices,
  providerSeatNames: string[],
): number {
  if (providerSeatNames.length === 0) return 0;
  const placeholders = providerSeatNames.map(() => "?").join(",");
  const row = services.db
    .query<{ n: number }, string[]>(
      `SELECT COUNT(*) AS n
         FROM handoffs h
        WHERE h.to_agent IN (${placeholders})
          AND (h.status='dispatched' OR ${SWEEPER_DRAINING_SQL})`,
    )
    .get(...providerSeatNames, sweeperDrainCutoffIso(services.clock?.() ?? new Date()));
  return row?.n ?? 0;
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
