export interface HttpSeatLike {
  readonly name: string;
  readonly adapter: string;
  readonly pricing_mode?: "api" | "subscription";
  readonly api_provider?: string;
}

export interface AssertNoBilledHttpSeatsOptions {
  readonly allowedProviders: readonly string[];
}

/**
 * A generated pricing_mode:"api" http seat must carry api_provider, and that
 * provider must be in the caller-supplied allowlist (self-hosted seats pass
 * by carrying api_provider:"local" with "local" in allowedProviders). A
 * missing api_provider on a billed seat is a generator bug, not an
 * exemption — it must be rejected, not skipped.
 */
export function assertNoBilledHttpSeats(
  agents: readonly HttpSeatLike[],
  opts: AssertNoBilledHttpSeatsOptions,
): void {
  const allowed = new Set(opts.allowedProviders);
  const offenders = agents.filter((agent) => {
    if (agent.adapter !== "openai-compat-http") return false;
    if ((agent.pricing_mode ?? "api") !== "api") return false;
    if (agent.api_provider === undefined) return true;
    return !allowed.has(agent.api_provider);
  });

  if (offenders.length === 0) return;

  const offenderList = offenders
    .map((agent) => `${agent.name} (provider: ${agent.api_provider ?? "<missing>"})`)
    .join(", ");
  throw new Error(
    `billed openai-compat-http seat(s) outside the allowed provider list: ${offenderList}`,
  );
}
