/**
 * Seat eligibility for scripts/plan-context.ts.
 *
 * Three sources have to agree before a seat can be pinned in a plan, and no
 * single one of them is sufficient:
 *   - the daemon registry (GET /chains/agents) is what `plan validate` checks
 *     preferred_agent/fallback_agent against;
 *   - agents.yaml carries maestro_capable, which plan-runtime enforces at RUN
 *     time and which the registry route does not expose at all;
 *   - the routing biases decide whether the fleet would route there today.
 *
 * The bias arithmetic is the router's own resolveProvider/resolveBiasEffect,
 * imported rather than reimplemented, so a change to routing semantics reaches
 * this context without anyone remembering to mirror it.
 */
import { resolveBiasEffect, resolveProvider } from "../packages/core/src/services/agent-routing.js";
import { PlanContextError } from "./plan-context-sources.js";

// Bias reasons run to several KB of operator prose. The context is a prompt
// payload, so report the provenance, not the essay.
const MAX_BIAS_REASON_CHARS = 240;

export interface SeatInput {
  api_provider?: string | null;
  maestro_capable?: boolean;
  name: string;
  pricing_mode?: string;
  subscription_provider?: string | null;
}

export interface BiasInput {
  expires_at?: string | null;
  mode: "boost" | "divert" | "exclude";
  reason?: string | null;
  scope: "agent" | "provider";
  value: string;
  weight?: number | null;
}

export interface EligibleSeat {
  factor: number;
  name: string;
  provider: string | null;
}

export interface ExcludedSeat {
  bias: BiasInput | null;
  name: string;
  provider: string | null;
}

export interface SeatContext {
  active_biases: BiasInput[];
  eligible: EligibleSeat[];
  excluded_by_bias: ExcludedSeat[];
  fallback_agent: string | null;
  maestro_capable_count: number;
  maestro_capable_unregistered: string[];
  preferred_agent: string | null;
  registered_count: number;
  selection_reason: string;
}

/* ------------------------------------------------------------------ seats */

/**
 * A bias with no expiry never lapses; an UNPARSEABLE expiry keeps the fence on
 * (fail closed — a malformed row must not silently re-admit an excluded seat).
 */
export function isBiasActive(bias: BiasInput, now: Date): boolean {
  const expires = bias.expires_at;
  if (expires === undefined || expires === null || expires.length === 0) {
    return true;
  }
  const parsed = Date.parse(expires);
  if (Number.isNaN(parsed)) {
    return true;
  }
  return parsed > now.getTime();
}

function findExcludingBias(
  name: string,
  provider: string | null,
  biases: readonly BiasInput[],
): BiasInput | null {
  for (const bias of biases) {
    if (bias.mode !== "exclude") {
      continue;
    }
    if (bias.scope === "agent" && bias.value === name) {
      return bias;
    }
    if (bias.scope === "provider" && provider !== null && bias.value === provider) {
      return bias;
    }
  }
  return null;
}

function summarizeBias(bias: BiasInput): BiasInput {
  const reason = bias.reason ?? null;
  return {
    ...bias,
    reason:
      reason !== null && reason.length > MAX_BIAS_REASON_CHARS
        ? `${reason.slice(0, MAX_BIAS_REASON_CHARS)}...`
        : reason,
  };
}

/** Only the biases that touch a considered seat, with the prose truncated. */
function relevantBiases(
  biases: readonly BiasInput[],
  considered: readonly ConsideredSeat[],
): BiasInput[] {
  const names = new Set(considered.map((seat) => seat.name));
  const providers = new Set(
    considered
      .map((seat) => seat.provider)
      .filter((provider): provider is string => provider !== null),
  );
  return biases
    .filter(
      (bias) =>
        (bias.scope === "agent" && names.has(bias.value)) ||
        (bias.scope === "provider" && providers.has(bias.value)),
    )
    .map((bias) => summarizeBias(bias));
}

function rankSeats(seats: readonly EligibleSeat[]): EligibleSeat[] {
  return seats
    .map((seat, index) => ({ index, seat }))
    .sort((left, right) => {
      if (right.seat.factor !== left.seat.factor) {
        return right.seat.factor - left.seat.factor;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.seat);
}

function pickSeatPair(ranked: readonly EligibleSeat[]): {
  fallback: string | null;
  preferred: string | null;
  reason: string;
} {
  const preferred = ranked[0];
  if (preferred === undefined) {
    return {
      fallback: null,
      preferred: null,
      reason: "no eligible seat: every registered maestro_capable seat is bias-excluded",
    };
  }
  const otherProvider = ranked.find(
    (seat) => seat.name !== preferred.name && seat.provider !== preferred.provider,
  );
  const fallback = otherProvider ?? ranked.find((seat) => seat.name !== preferred.name);
  if (fallback === undefined) {
    return {
      fallback: preferred.name,
      preferred: preferred.name,
      reason: "single eligible seat: fallback repeats preferred",
    };
  }
  const tail =
    otherProvider === undefined
      ? "fallback is the next eligible seat (no second provider is eligible)"
      : "fallback is the next eligible seat on a different provider";
  return {
    fallback: fallback.name,
    preferred: preferred.name,
    reason: `preferred ranks by live routing-bias factor, then config order; ${tail}`,
  };
}

export interface SeatContextInput {
  biases: readonly BiasInput[];
  now: Date;
  registered: readonly string[];
  seats: readonly SeatInput[];
}

interface ConsideredSeat {
  name: string;
  provider: string | null;
}

function partitionSeats(
  considered: readonly ConsideredSeat[],
  registered: ReadonlySet<string>,
  activeBiases: readonly BiasInput[],
): {
  eligible: EligibleSeat[];
  excluded: ExcludedSeat[];
  unregistered: string[];
} {
  const eligible: EligibleSeat[] = [];
  const excluded: ExcludedSeat[] = [];
  const unregistered: string[] = [];
  for (const seat of considered) {
    if (!registered.has(seat.name)) {
      unregistered.push(seat.name);
      continue;
    }
    const effect = resolveBiasEffect(seat.name, seat.provider, activeBiases);
    if (effect.exclude) {
      const bias = findExcludingBias(seat.name, seat.provider, activeBiases);
      excluded.push({
        bias: bias === null ? null : summarizeBias(bias),
        name: seat.name,
        provider: seat.provider,
      });
      continue;
    }
    eligible.push({
      factor: effect.factor,
      name: seat.name,
      provider: seat.provider,
    });
  }
  return { eligible, excluded, unregistered };
}

/**
 * Intersect the daemon registry (what `plan validate` accepts) with
 * maestro_capable (what plan-runtime additionally requires, and which the
 * registry route does not carry), then subtract active bias exclusions using
 * the router's own resolveProvider/resolveBiasEffect rather than a private
 * reimplementation of them.
 */
export function computeSeatContext(input: SeatContextInput): SeatContext {
  const activeBiases = input.biases.filter((bias) => isBiasActive(bias, input.now));
  const considered: ConsideredSeat[] = input.seats
    .filter((seat) => seat.maestro_capable === true)
    .map((seat) => ({ name: seat.name, provider: resolveProvider(seat) }));
  const partition = partitionSeats(considered, new Set(input.registered), activeBiases);
  const ranked = rankSeats(partition.eligible);
  const pair = pickSeatPair(ranked);
  return {
    active_biases: relevantBiases(activeBiases, considered),
    eligible: ranked,
    excluded_by_bias: partition.excluded,
    fallback_agent: pair.fallback,
    maestro_capable_count: considered.length,
    maestro_capable_unregistered: partition.unregistered,
    preferred_agent: pair.preferred,
    registered_count: input.registered.length,
    selection_reason: pair.reason,
  };
}

function recordsUnder(payload: unknown, key: string, path: string): Record<string, unknown>[] {
  const list =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)[key]
      : undefined;
  if (!Array.isArray(list)) {
    throw new PlanContextError(`daemon ${path} response carries no ${key} array`);
  }
  return list.filter(
    (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
  );
}

/** Seat names `plan validate` will accept, from the live registry. */
export function parseAgentNames(payload: unknown): string[] {
  const names = recordsUnder(payload, "agents", "/chains/agents")
    .map((entry) => entry["name"])
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  if (names.length === 0) {
    throw new PlanContextError("daemon /chains/agents returned no seat names");
  }
  return names;
}

export function parseBiases(payload: unknown): BiasInput[] {
  return recordsUnder(payload, "biases", "/routing/bias").flatMap((entry) => {
    const scope = entry["scope"];
    const value = entry["value"];
    const mode = entry["mode"];
    if (
      (scope !== "agent" && scope !== "provider") ||
      typeof value !== "string" ||
      (mode !== "boost" && mode !== "divert" && mode !== "exclude")
    ) {
      return [];
    }
    return [
      {
        expires_at: typeof entry["expires_at"] === "string" ? entry["expires_at"] : null,
        mode,
        reason: typeof entry["reason"] === "string" ? entry["reason"] : null,
        scope,
        value,
        weight: typeof entry["weight"] === "number" ? entry["weight"] : null,
      },
    ];
  });
}
