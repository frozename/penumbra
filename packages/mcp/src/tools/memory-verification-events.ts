import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const MemoryVerificationEventsInputShape = {
  memory_id: z.string().min(1).describe("Memory id to read audit events for"),
  limit: z.number().int().optional().describe("Max events to return (default 50, max 200)"),
};

const MemoryVerificationEventsSchema = z.object(MemoryVerificationEventsInputShape).strict();

export function memoryVerificationEventsHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = MemoryVerificationEventsSchema.parse(input);
    return toTextContent(await daemon.memoryVerificationEvents(parsed));
  };
}
