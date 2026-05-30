import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import { makeEnvelopeResult } from "../responses/envelope.js";
import { estimateTokens, truncateToTokens, DEFAULT_BUDGET } from "../responses/budget.js";

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
  envelope: z
    .boolean()
    .optional()
    .describe(
      "When true, return a token-budgeted envelope with _meta.token_budget + result_bytes instead of the raw payload.",
    ),
};

export function reconcilerVerdictsHandler(daemon: Pick<DaemonClient, "reconcilerVerdicts">) {
  return async (input: {
    since?: string;
    limit?: number;
    only_unverified?: boolean;
    envelope?: boolean;
  }) => {
    const out = await daemon.reconcilerVerdicts({
      since: input.since,
      limit: input.limit,
      only_unverified: input.only_unverified,
    });
    const rawJson = JSON.stringify(out, null, 2);
    if (input.envelope) {
      const resultBytes = Buffer.byteLength(rawJson, "utf8");
      const { text, truncated } = truncateToTokens(rawJson, DEFAULT_BUDGET);
      return makeEnvelopeResult([{ type: "text", text }], {
        usedTokens: estimateTokens(text),
        limitTokens: DEFAULT_BUDGET,
        truncated,
        resultBytes,
      });
    }
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
