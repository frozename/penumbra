import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const RoutingBiasSetInputSchema = z
  .object({
    scope: z.enum(["provider", "agent"]),
    value: z.string().min(1),
    mode: z.enum(["boost", "divert", "exclude"]),
    weight: z.number().min(0).max(2.0).optional(),
    ttl_seconds: z.number().int().positive().optional(),
    expires_at: z.string().datetime().optional(),
    reason: z.string().optional(),
  })
  .refine((data) => data.ttl_seconds !== undefined || data.expires_at !== undefined, {
    message: "Either ttl_seconds or expires_at must be provided",
    path: ["ttl_seconds"],
  });

export const RoutingBiasSetInputShape = RoutingBiasSetInputSchema.shape;

export type RoutingBiasSetInput = z.infer<typeof RoutingBiasSetInputSchema>;

export function routingBiasSetHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = RoutingBiasSetInputSchema.parse(input);
    const out = await daemon.routingBiasSet(parsed);
    return toTextContent(out);
  };
}
