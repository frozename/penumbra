import type { AgentConfig } from "../files/agents.js";
import type { ModelAliasMap } from "../files/model-aliases.js";

// The 5 role tags actually consumed by daemon code as of 2026-08-19 (see
// packages/config/test/generator/role-floors.test.ts for the per-tag source pin).
// Retiring a seat that holds one of these silently zeroes a live subsystem.
export const CONSUMED_ROLE_TAGS = [
  "dreaming-rewriter",
  "brief-synthesizer",
  "dreaming-judge",
  "memory-refiner",
  "refiner",
] as const;
export type ConsumedRoleTag = (typeof CONSUMED_ROLE_TAGS)[number];

const DREAMING_JUDGE_MIN_HOLDERS = 2;

function lineageKey(agentName: string, aliasMap: ModelAliasMap): string {
  const alias = aliasMap[agentName];
  // No alias entry means we cannot prove this holder shares lineage with
  // another; treat it as its own unique lineage rather than a false collision.
  return alias ? `${alias.aa_creator}${alias.aa_slug}` : `unresolved${agentName}`;
}

/**
 * Throws with every violation aggregated (not just the first) when the given
 * agent roster fails to meet the role floors that daemon code depends on:
 * each of CONSUMED_ROLE_TAGS must have at least one holder, and dreaming-judge
 * needs >=2 holders that resolve to distinct (aa_creator, aa_slug) lineages
 * via the alias map — a same-lineage pair is one voter with duplicate ballots.
 */
export function assertRoleFloors(agents: readonly AgentConfig[], aliasMap: ModelAliasMap): void {
  const violations: string[] = [];

  for (const roleTag of CONSUMED_ROLE_TAGS) {
    const holders = agents.filter((agent) => agent.roles.includes(roleTag));

    if (holders.length === 0) {
      violations.push(`role '${roleTag}' has zero holders`);
      continue;
    }

    if (roleTag === "dreaming-judge" && holders.length < DREAMING_JUDGE_MIN_HOLDERS) {
      violations.push(
        `role 'dreaming-judge' has ${String(holders.length)} holder(s), needs at least ${String(DREAMING_JUDGE_MIN_HOLDERS)}`,
      );
      continue;
    }

    if (roleTag === "dreaming-judge") {
      const lineages = new Set(holders.map((agent) => lineageKey(agent.name, aliasMap)));
      if (lineages.size < 2) {
        const holderNames = holders.map((agent) => agent.name).join(", ");
        violations.push(
          `role 'dreaming-judge' holders [${holderNames}] all resolve to the same (aa_creator, aa_slug) lineage — quorum is one voter with duplicate ballots`,
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`role floor violation(s):\n${violations.map((v) => `  - ${v}`).join("\n")}`);
  }
}
