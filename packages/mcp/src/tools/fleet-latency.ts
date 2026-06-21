import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const FleetLatencyInputSchema = z.object({
  window_hours: z.coerce
    .number()
    .positive()
    .max(24 * 30)
    .default(24),
});

export const FleetLatencyInputShape = FleetLatencyInputSchema.shape;

export function fleetLatencyHandler(daemon: Pick<DaemonClient, "fleetLatency">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = FleetLatencyInputSchema.parse(input ?? {});
    return toTextContent(await daemon.fleetLatency({ window_hours: parsed.window_hours }));
  };
}
