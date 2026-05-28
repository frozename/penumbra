import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const COST_QUOTA_STATUS_DESCRIPTION =
  "Returns per-provider quota status with lane-aware USD split (billed vs synth) and per-row subscription_pressure snapshots.";

export const CostQuotaStatusInputSchema = z.object({
  since: z
    .string()
    .optional()
    .describe("ISO 8601 datetime (UTC)")
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
      message: "since must be a valid ISO 8601 datetime",
    }),
});

export const CostQuotaStatusInputShape = CostQuotaStatusInputSchema.shape;

export type CostQuotaStatusInput = z.infer<typeof CostQuotaStatusInputSchema>;

export function costQuotaStatusHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = CostQuotaStatusInputSchema.parse(input ?? {});
    const out = await daemon.costQuotaStatus({ since: parsed.since });
    return toTextContent(out);
  };
}
