import type { AgentsConfig } from "../files/agents.js";
import type { ModelAliasMap } from "../files/model-aliases.js";
import type { RoutingConfig } from "../files/routing.js";

import { assertNoBilledHttpSeats } from "./assertions.js";
import { assertNoRoleTagCollision, assertUniqueSeatNames, type SeatNameInput } from "./naming.js";
import { assertRoleFloors } from "./role-floors.js";
import { assertPruneSafe } from "./routing-refs.js";

export interface GeneratorSafetyGateContext {
  readonly allowedProviders: readonly string[];
  readonly aliasMap: ModelAliasMap;
  readonly roleTags: readonly string[];
  readonly seatNameInputs: readonly SeatNameInput[];
  readonly candidatePrunes: readonly string[];
  readonly routing: RoutingConfig;
}

export interface GeneratorSafetyGateResult {
  readonly ok: boolean;
  readonly violations: string[];
}

/**
 * P4's single gate between a generated candidate config and the write to
 * disk: runs all five generator-toolkit assertions and aggregates every
 * violation rather than stopping at the first, so a candidate that fails
 * multiple independent safety checks at once surfaces all of them in one
 * report. Never throws — a thrown assertion is caught and its message
 * folded into `violations`, so the caller always gets a report back and
 * decides whether to proceed.
 */
export function runGeneratorSafetyGate(
  candidateConfig: AgentsConfig,
  ctx: GeneratorSafetyGateContext,
): GeneratorSafetyGateResult {
  const violations: string[] = [];

  const guard = (assertion: () => void): void => {
    try {
      assertion();
    } catch (err) {
      violations.push(err instanceof Error ? err.message : String(err));
    }
  };

  guard(() =>
    assertNoBilledHttpSeats(candidateConfig.agents, { allowedProviders: ctx.allowedProviders }),
  );
  guard(() => assertRoleFloors(candidateConfig.agents, ctx.aliasMap));
  guard(() =>
    assertNoRoleTagCollision(
      candidateConfig.agents.map((agent) => agent.name),
      ctx.roleTags,
    ),
  );
  guard(() => assertUniqueSeatNames(ctx.seatNameInputs));
  guard(() => assertPruneSafe(ctx.candidatePrunes, ctx.routing));

  return { ok: violations.length === 0, violations };
}
