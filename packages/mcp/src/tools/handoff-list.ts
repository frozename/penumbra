import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { formatHandoffListPending, wrapWithSummary } from "../format-summary.js";

export const ListHandoffsInputShape = {
  conversation_id: z.string().optional(),
};

interface HandoffListResult {
  content: { type: "text"; text: string }[];
}

export function listHandoffsHandler(
  daemon: DaemonClient,
): (input: { conversation_id?: string }) => Promise<HandoffListResult> {
  return async (input): Promise<HandoffListResult> => {
    const r = await daemon.listPendingHandoffs(
      input.conversation_id ? { conversation_id: input.conversation_id } : {},
    );
    return {
      content: [
        {
          type: "text" as const,
          text: wrapWithSummary(formatHandoffListPending(r), r.handoffs),
        },
      ],
    };
  };
}
