import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";

export const ChainStatusInputShape = {
  handoff_id: z.string().min(1).describe("The ID of the handoff to query status for."),
};

import { formatChainStatus, wrapWithSummary } from "../format-summary.js";

export function chainStatusHandler(daemon: DaemonClient) {
  return async (input: { handoff_id: string }) => {
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
