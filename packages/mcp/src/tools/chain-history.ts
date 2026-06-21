import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { type ToolHandler, type ToolResult } from "./context.js";

export const ChainHistoryInputShape = {
  conversation_id: z.string().describe("The conversation ID to query history for."),
  limit: z.number().optional().default(50).describe("Maximum number of events to return."),
};

export const chainHistoryHandler =
  (daemon: DaemonClient): ToolHandler<{ conversation_id: string; limit?: number }> =>
  async (args): Promise<ToolResult> => {
    const { history } = await daemon.listChainHistory(args.conversation_id, args.limit);
    const rawJson = JSON.stringify(history, null, 2);
    return {
      content: [{ type: "text", text: rawJson }],
    };
  };
