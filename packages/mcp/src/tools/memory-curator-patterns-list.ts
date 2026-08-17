import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const MemoryCuratorPatternsListInputShape = {
  status: z
    .enum(["queued", "approved", "rejected", "all"])
    .optional()
    .describe("Filter by status (default: approved)"),
};

const Schema = z.object(MemoryCuratorPatternsListInputShape);

export function memoryCuratorPatternsListHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = Schema.parse(input ?? {});
    return toTextContent(await daemon.getCuratorPatterns(parsed));
  };
}
