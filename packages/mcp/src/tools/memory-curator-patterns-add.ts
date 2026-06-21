import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const MemoryCuratorPatternsAddInputShape = {
  pattern: z.string().min(1).describe("Pattern string to match against memory content"),
  reason: z.string().min(1).describe("Why this pattern is being proposed"),
  proposed_by: z.string().optional().describe("Identifier of the proposer (default: mcp-caller)"),
};

const Schema = z.object(MemoryCuratorPatternsAddInputShape);

export function memoryCuratorPatternsAddHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = Schema.parse(input);
    return toTextContent(await daemon.postCuratorPatterns(parsed));
  };
}
