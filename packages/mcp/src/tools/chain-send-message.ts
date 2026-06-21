import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { DaemonHttpError } from "../daemon-client.js";
import { type ToolHandler, type ToolResult } from "./context.js";

export const ChainSendMessageInputShape = {
  handoff_id: z
    .string()
    .min(1)
    .describe("The handoff ID whose live ACP session should receive the message."),
  content: z
    .string()
    .min(1)
    .max(8000)
    .describe("The user-text message to inject into the live session."),
};

export function chainSendMessageHandler(
  daemon: DaemonClient,
): ToolHandler<{ handoff_id: string; content: string }> {
  return async (args): Promise<ToolResult> => {
    try {
      const res = await daemon.sendChainMessage({
        handoff_id: args.handoff_id,
        content: args.content,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof DaemonHttpError) {
        if (err.status === 404) {
          throw new Error(
            `chain_send_message session not found: handoff ${args.handoff_id} not found`,
          );
        }
        if (err.status === 409) {
          throw new Error("chain_send_message adapter does not support mid-session inject");
        }
      }
      throw err;
    }
  };
}
