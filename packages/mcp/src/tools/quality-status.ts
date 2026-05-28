import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const QualityStatusInputShape = {
  window_hours: z.number().optional().describe("Hours of history to include (default 24, max 168)"),
  min_samples: z
    .number()
    .optional()
    .describe("Minimum samples to include in recommendation summaries (default 3)"),
};

const QualityStatusSchema = z.object(QualityStatusInputShape).strict();

export function qualityStatusHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = QualityStatusSchema.parse(input);
    return toTextContent(await daemon.qualityStatus(parsed));
  };
}
