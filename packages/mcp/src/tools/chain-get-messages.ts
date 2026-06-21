import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { type ToolHandler, type ToolResult } from "./context.js";

export const ChainGetMessagesInputShape = z.object({
  conversation_id: z.string().describe("The conversation ID to query messages for."),
  types: z.array(z.string()).optional().describe("Optional array of event types to filter by."),
});

export function chainGetMessagesHandler(
  daemon: DaemonClient,
): ToolHandler<z.infer<typeof ChainGetMessagesInputShape>> {
  return async (args): Promise<ToolResult> => {
    try {
      const res = await daemon.getChainMessages(args.conversation_id, args.types);
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to fetch chain messages: ${message}` }],
      };
    }
  };
}
