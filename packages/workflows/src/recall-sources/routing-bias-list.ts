import type { Database } from "bun:sqlite";

import { readRoutingBiases, type RoutingBias } from "@penumbra/core";

export type RoutingBiasListRow = RoutingBias;

export type RoutingBiasListSourceOutput = {
  rows: RoutingBiasListRow[];
  warnings: string[];
};

type RoutingBiasListArgs = {
  scope?: "provider" | "agent";
  value?: string;
  limit?: number;
};

function normalizeArgs(args: Record<string, unknown>): RoutingBiasListArgs {
  const scope = args.scope === "provider" || args.scope === "agent" ? args.scope : undefined;
  const value = typeof args.value === "string" && args.value.length > 0 ? args.value : undefined;
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 50;
  return {
    ...(scope ? { scope } : {}),
    ...(value ? { value } : {}),
    limit: Math.max(1, Math.min(500, Math.trunc(limit))),
  };
}

function modeRank(mode: RoutingBias["mode"]): number {
  switch (mode) {
    case "exclude":
      return 0;
    case "divert":
      return 1;
    case "boost":
      return 2;
  }
}

export function runRoutingBiasListSource(input: {
  db: Database;
  args?: Record<string, unknown>;
  now?: () => Date;
}): RoutingBiasListSourceOutput {
  try {
    const args = normalizeArgs(input.args ?? {});
    const rows = readRoutingBiases(input.db, {
      now: input.now ? input.now() : new Date(),
      ...(args.scope ? { scope: args.scope } : {}),
      ...(args.value ? { value: args.value } : {}),
    })
      .sort(
        (a, b) => modeRank(a.mode) - modeRank(b.mode) || a.expires_at.localeCompare(b.expires_at),
      )
      .slice(0, args.limit)
      .map((row) => ({
        ...row,
        reason: row.reason === null ? null : row.reason.slice(0, 160),
      }));
    return { rows, warnings: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rows: [], warnings: [`routing_bias_list: ${msg}`] };
  }
}
