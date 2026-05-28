import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";
import { wrapWithSummary } from "../format-summary.js";

export const CostRecentInputSchema = z.object({
  since: z
    .string()
    .optional()
    .describe("ISO 8601 datetime (UTC)")
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
      message: "since must be a valid ISO 8601 datetime",
    }),
  project_id: z.string().min(1).nullable().optional(),
});

export const CostRecentInputShape = CostRecentInputSchema.shape;

export type CostRecentInput = z.infer<typeof CostRecentInputSchema>;

export function costRecentHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = CostRecentInputSchema.parse(input ?? {});
    const out = await daemon.costRecent({
      since: parsed.since,
      project_id: parsed.project_id ?? null,
    });
    return toTextContent(wrapWithSummary(formatCostRecent(out), out));
  };
}

type CostRecentShape = {
  handoff_count: number;
  window: { from: string; to: string };
  by_provider: Array<{
    provider: string | null;
    subscription_pressure?: Array<{
      window_label: string;
      used_pct: number;
    }>;
  }>;
};

function formatCostRecent(out: CostRecentShape): string {
  const lines = [
    `● cost.recent  providers=${out.by_provider.length}  handoffs=${out.handoff_count}  window=${out.window.from}..${out.window.to}`,
  ];
  for (const providerRow of out.by_provider) {
    const pressureSummary = formatPressure(providerRow.subscription_pressure);
    if (!pressureSummary) continue;
    const provider = providerRow.provider ?? "unknown";
    lines.push(`◐ ${provider} pressure ${pressureSummary}`);
  }
  return lines.join("\n");
}

function formatPressure(
  rows: Array<{ window_label: string; used_pct: number }> | undefined,
): string {
  if (!rows) return "";
  const active = rows.filter((row) => row.used_pct > 0);
  if (active.length === 0) return "";
  return active.map((row) => `${row.window_label}:${row.used_pct}%`).join(" ");
}
