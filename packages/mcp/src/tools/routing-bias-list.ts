import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const RoutingBiasListInputSchema = z.object({
  scope: z.enum(["provider", "agent"]).optional(),
  value: z.string().min(1).optional(),
});

export const RoutingBiasListInputShape = RoutingBiasListInputSchema.shape;

export type RoutingBiasListInput = z.infer<typeof RoutingBiasListInputSchema>;

export function routingBiasListHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = RoutingBiasListInputSchema.parse(input ?? {});
    const out = await daemon.routingBiasList(parsed);
    return toTextContent(out);
  };
}
