import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { formatChainStatus, wrapWithSummary } from "../format-summary.js";
import { type ToolHandler, type ToolResult } from "./context.js";

export const ChainStatusInputShape = {
  handoff_id: z.string().min(1).describe("The ID of the handoff to query status for."),
};

export function chainStatusHandler(daemon: DaemonClient): ToolHandler<{ handoff_id: string }> {
  return async (input): Promise<ToolResult> => {
    const status = await daemon.getHandoffStatus(input.handoff_id);
    return {
      content: [
        {
          type: "text",
          text: wrapWithSummary(formatChainStatus(status), status),
        },
      ],
    };
  };
}
