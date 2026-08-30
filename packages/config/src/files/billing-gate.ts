export const BILLED_HAND_SEAT_WHITELIST = ["deepseek-v4-flash-http"] as const;

export const UNBILLED_API_PROVIDERS = ["local"] as const;

export const GENERATOR_PROVENANCE_SOURCE = "providers-sync" as const;

export class BilledHandSeatViolation extends Error {
  override name = "BilledHandSeatViolation";
}

export function isBilledHandSeatViolation(error: unknown): error is BilledHandSeatViolation {
  return error instanceof BilledHandSeatViolation;
}

export interface HandBilledSeatLike {
  readonly name: string;
  readonly adapter: string;
  readonly pricing_mode?: "api" | "subscription";
  readonly api_provider?: string;
  readonly provenance?: {
    readonly source?: string;
  };
}

export interface AssertHandBilledSeatsWhitelistedOptions {
  readonly whitelist?: readonly string[];
  readonly unbilledProviders?: readonly string[];
}

/**
 * Config-load tripwire for hand-authored seats. Generated seats are already
 * gated at generation time (assertNoBilledHttpSeats); a hand seat whose
 * api_provider implies per-token billing must be deliberately whitelisted,
 * and a billed openai-compat-http seat missing api_provider is a config bug,
 * not an exemption.
 */
export function assertHandBilledSeatsWhitelisted(
  agents: readonly HandBilledSeatLike[],
  opts: AssertHandBilledSeatsWhitelistedOptions = {},
): void {
  const whitelist = new Set<string>(opts.whitelist ?? BILLED_HAND_SEAT_WHITELIST);
  const unbilled = new Set<string>(opts.unbilledProviders ?? UNBILLED_API_PROVIDERS);
  const offenders = agents.filter((agent) => {
    if (agent.provenance?.source === GENERATOR_PROVENANCE_SOURCE) return false;
    if ((agent.pricing_mode ?? "api") !== "api") return false;
    if (agent.api_provider !== undefined) {
      return !unbilled.has(agent.api_provider) && !whitelist.has(agent.name);
    }
    return agent.adapter === "openai-compat-http";
  });

  if (offenders.length === 0) return;

  const offenderList = offenders
    .map((agent) => `${agent.name} (provider: ${agent.api_provider ?? "<missing>"})`)
    .join(", ");
  throw new BilledHandSeatViolation(
    `hand-authored per-token-billed seat(s) outside the whitelist: ${offenderList}; ` +
      "hand-authored per-token-billed seats must be deliberately whitelisted: add the seat name to BILLED_HAND_SEAT_WHITELIST in packages/config/src/files/billing-gate.ts (one line), or set pricing_mode: subscription / api_provider: local if the seat is not per-token billed",
  );
}
