import type { AgentDescriptor } from "./eligibility.js";

export type AgentRankRow = {
  agent_name: string;
  score: number;
  avg_latency_ms?: number | null;
};

export function pickPreferred(
  rankings: AgentRankRow[],
  eligible: AgentDescriptor[],
): { agent_id: string; score: number } | null {
  const eligibleNames = new Set(eligible.map((agent) => agent.name));
  const filtered = rankings.filter((row) => eligibleNames.has(row.agent_name));
  if (filtered.length === 0) return null;

  let best = filtered[0]!;
  for (let i = 1; i < filtered.length; i += 1) {
    const row = filtered[i]!;
    if (row.score > best.score) {
      best = row;
      continue;
    }
    const bestLatency = best.avg_latency_ms ?? Infinity;
    const rowLatency = row.avg_latency_ms ?? Infinity;
    if (row.score === best.score && rowLatency < bestLatency) {
      best = row;
      continue;
    }
    if (
      row.score === best.score &&
      rowLatency === bestLatency &&
      row.agent_name.localeCompare(best.agent_name) < 0
    ) {
      best = row;
    }
  }

  return { agent_id: best.agent_name, score: best.score };
}
