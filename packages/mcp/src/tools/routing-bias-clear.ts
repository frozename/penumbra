import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { RoutingBiasClearInputSchema } from "@penumbra/core";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export { RoutingBiasClearInputSchema, RoutingBiasClearInputShape } from "@penumbra/core";

export type RoutingBiasClearInput = z.infer<typeof RoutingBiasClearInputSchema>;

export function routingBiasClearHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = RoutingBiasClearInputSchema.parse(input);
    const out = await daemon.routingBiasClear(parsed);
    return toTextContent(out);
  };
}
