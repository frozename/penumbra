import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const MemoryEfficacyRecentInputShape = {
  since: z.string().optional().describe("ISO date string to filter findings from"),
  limit: z.number().optional().describe("Max recent entries to return (default 20, max 100)"),
  include_raw: z.boolean().optional().describe("Include raw_response_json for each recent entry"),
};

const MemoryEfficacyRecentSchema = z.object(MemoryEfficacyRecentInputShape).strict();

export function memoryEfficacyRecentHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = MemoryEfficacyRecentSchema.parse(input);
    return toTextContent(await daemon.memoryEfficacyRecent(parsed));
  };
}
