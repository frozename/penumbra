import type { DaemonClient } from "../daemon-client.js";

import { type ToolHandler, type ToolResult } from "./context.js";

export const ChainListAgentsInputShape = {};

export const chainListAgentsHandler =
  (daemon: DaemonClient): ToolHandler<Record<string, never>> =>
  async (_args): Promise<ToolResult> => {
    const { agents } = await daemon.listChainAgents();
    const rawJson = JSON.stringify({ agents }, null, 2);
    return {
      content: [{ type: "text", text: rawJson }],
    };
  };
