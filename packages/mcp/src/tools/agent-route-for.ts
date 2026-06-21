import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const AgentRouteForInputSchema = z.object({
  role: z.string().min(1),
  window_days: z.coerce.number().int().positive().optional(),
  min_samples: z.coerce.number().int().positive().optional(),
  agent_kind: z.enum(["coding", "long_lived"]).optional(),
});

export const AgentRouteForInputShape = AgentRouteForInputSchema.shape;

export function agentRouteForHandler(daemon: Pick<DaemonClient, "agentRouteFor">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = AgentRouteForInputSchema.parse(input ?? {});
    const out = await daemon.agentRouteFor({
      role: parsed.role,
      window_days: parsed.window_days,
      min_samples: parsed.min_samples,
      agent_kind: parsed.agent_kind,
    });
    return toTextContent(out);
  };
}
