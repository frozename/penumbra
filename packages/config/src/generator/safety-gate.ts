import type { AgentsConfig } from "../files/agents.js";
import type { ModelAliasMap } from "../files/model-aliases.js";
import type { RoutingConfig } from "../files/routing.js";

import { assertNoBilledGeneratedSeats, assertNoBilledHttpSeats } from "./assertions.js";
import {
  assertNoRoleTagCollision,
  assertUniqueSeatNames,
  seatNameFor,
  type SeatNameInput,
} from "./naming.js";
import { assertRoleFloors } from "./role-floors.js";
import { assertPruneSafe } from "./routing-refs.js";

export interface GeneratorSafetyGateContext {
  readonly allowedProviders: readonly string[];
  readonly generatorSource: string;
  readonly aliasMap: ModelAliasMap;
  readonly roleTags: readonly string[];
  readonly seatNameInputs: readonly SeatNameInput[];
  readonly candidatePrunes: readonly string[];
  readonly routing: RoutingConfig;
}

export interface GeneratorSafetyGateResult {
  readonly ok: boolean;
  readonly violations: string[];
  readonly warnings: string[];
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
  const warnings: string[] = [];

  const guard = (assertion: () => void): void => {
    try {
      assertion();
    } catch (err) {
      violations.push(err instanceof Error ? err.message : String(err));
    }
  };

  guard(() => {
    assertNoBilledHttpSeats(candidateConfig.agents, { allowedProviders: ctx.allowedProviders });
  });
  guard(() => {
    assertNoBilledGeneratedSeats(candidateConfig.agents, {
      allowedProviders: ctx.allowedProviders,
      generatorSource: ctx.generatorSource,
    });
  });
  guard(() => {
    assertRoleFloors(candidateConfig.agents, ctx.aliasMap);
  });
  const generatedSeatNames = ctx.seatNameInputs.flatMap((input) => {
    try {
      return [seatNameFor(input.source, input.modelSlug, input.effort)];
    } catch {
      return [];
    }
  });
  guard(() => {
    assertNoRoleTagCollision(generatedSeatNames, ctx.roleTags);
  });
  guard(() => {
    assertUniqueSeatNames(ctx.seatNameInputs);
  });
  guard(() => {
    assertPruneSafe(ctx.candidatePrunes, ctx.routing);
  });

  const generatedNameSet = new Set(generatedSeatNames);
  const roleTagSet = new Set(ctx.roleTags);
  const preExistingCollisions = candidateConfig.agents
    .map((agent) => agent.name)
    .filter((name) => !generatedNameSet.has(name) && roleTagSet.has(name));
  if (preExistingCollisions.length > 0) {
    warnings.push(
      "pre-existing seat name(s) equal live role tag(s) (exact-name dispatch will silently role-route): " +
        preExistingCollisions.join(", "),
    );
  }

  return { ok: violations.length === 0, violations, warnings };
}
