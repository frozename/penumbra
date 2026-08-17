import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const RoutingBiasClearInputSchema = z
  .object({
    bias_id: z.string().min(1).optional(),
    scope: z.enum(["provider", "agent"]).optional(),
    value: z.string().min(1).optional(),
    all: z.literal(true).optional(),
    confirm: z.literal(true).optional(),
  })
  .refine(
    (data) => {
      if (data.all) {
        return data.confirm === true;
      }
      if (data.bias_id) {
        return true;
      }
      if (data.scope && data.value) {
        return true;
      }
      return false;
    },
    {
      message: "Clear requires bias_id, (scope + value), or all:true with confirm:true",
    },
  );

export const RoutingBiasClearInputShape = RoutingBiasClearInputSchema.shape;

export type RoutingBiasClearInput = z.infer<typeof RoutingBiasClearInputSchema>;

export function routingBiasClearHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = RoutingBiasClearInputSchema.parse(input);
    const out = await daemon.routingBiasClear(parsed);
    return toTextContent(out);
  };
}
