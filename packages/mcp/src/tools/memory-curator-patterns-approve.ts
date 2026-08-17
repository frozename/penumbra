import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const MemoryCuratorPatternsApproveInputShape = {
  pattern_id: z.string().min(1).describe("The pattern_id to approve"),
};

const Schema = z.object(MemoryCuratorPatternsApproveInputShape);

export function memoryCuratorPatternsApproveHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = Schema.parse(input);
    return toTextContent(await daemon.postCuratorPatternApprove(parsed));
  };
}
