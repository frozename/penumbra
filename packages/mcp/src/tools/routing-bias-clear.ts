import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import {
  RoutingBiasClearInputSchema as CoreRoutingBiasClearInputSchema,
  RoutingBiasClearInputShape as CoreRoutingBiasClearInputShape,
} from "@penumbra/core";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const RoutingBiasClearInputSchema = CoreRoutingBiasClearInputSchema;
export const RoutingBiasClearInputShape = CoreRoutingBiasClearInputShape;

export type RoutingBiasClearInput = z.infer<typeof RoutingBiasClearInputSchema>;

export function routingBiasClearHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = RoutingBiasClearInputSchema.parse(input);
    const out = await daemon.routingBiasClear(parsed);
    return toTextContent(out);
  };
}
