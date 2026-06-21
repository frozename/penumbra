import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const DispatchTimelineInputShape = {
  handoff_id: z
    .string()
    .min(1)
    .describe("The handoff_id whose dispatch event timeline should be returned."),
};

interface DispatchTimelineResult {
  content: { type: "text"; text: string }[];
}

export function dispatchTimelineHandler(
  daemon: Pick<DaemonClient, "getDispatchTimeline">,
): (input: { handoff_id: string }) => Promise<DispatchTimelineResult> {
  return async (input): Promise<DispatchTimelineResult> => {
    const timeline = await daemon.getDispatchTimeline(input.handoff_id);
    const rawJson = JSON.stringify(timeline, null, 2);
    return {
      content: [
        {
          type: "text" as const,
          text: rawJson,
        },
      ],
    };
  };
}
