import type { DaemonClient } from "../daemon-client.js";

export const ChainListAgentsInputShape = {};

export const chainListAgentsHandler =
  (daemon: DaemonClient) => async (_args: Record<string, never>) => {
    const { agents } = await daemon.listChainAgents();
    const rawJson = JSON.stringify({ agents }, null, 2);
    return {
      content: [{ type: "text", text: rawJson }],
    };
  };
