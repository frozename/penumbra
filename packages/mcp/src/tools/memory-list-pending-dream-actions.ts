import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const MemoryListPendingDreamActionsInputShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum actions to return (default 100, max 500)"),
};

const Schema = z.object(MemoryListPendingDreamActionsInputShape);

export function memoryListPendingDreamActionsHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = Schema.parse(input ?? {});
    return toTextContent(await daemon.listPendingDreamActions(parsed));
  };
}
