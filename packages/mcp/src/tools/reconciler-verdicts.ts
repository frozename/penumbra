import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const ReconcilerVerdictsInputShape = {
  since: z.string().optional().describe("Optional lower-bound timestamp (ISO-8601)."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(50)
    .describe("Maximum verdicts to return (default 50)."),
  only_unverified: z
    .boolean()
    .optional()
    .describe("When true, include only verdicts without a PR URL."),
};

interface ReconcilerVerdictsResult {
  content: { type: "text"; text: string }[];
}

export function reconcilerVerdictsHandler(
  daemon: Pick<DaemonClient, "reconcilerVerdicts">,
): (input: {
  since?: string;
  limit?: number;
  only_unverified?: boolean;
}) => Promise<ReconcilerVerdictsResult> {
  return async (input): Promise<ReconcilerVerdictsResult> => {
    const out = await daemon.reconcilerVerdicts({
      since: input.since,
      limit: input.limit,
      only_unverified: input.only_unverified,
    });
    const rawJson = JSON.stringify(out, null, 2);
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
