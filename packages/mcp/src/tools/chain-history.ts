import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import { makeEnvelopeResult } from "../responses/envelope.js";
import { estimateTokens, truncateToTokens, DEFAULT_BUDGET } from "../responses/budget.js";

export const ChainHistoryInputShape = {
  conversation_id: z.string().describe("The conversation ID to query history for."),
  limit: z.number().optional().default(50).describe("Maximum number of events to return."),
  envelope: z
    .boolean()
    .optional()
    .describe(
      "When true, return a token-budgeted envelope with _meta.token_budget + result_bytes instead of the raw payload.",
    ),
};

export const chainHistoryHandler =
  (daemon: DaemonClient) =>
  async (args: { conversation_id: string; limit?: number; envelope?: boolean }) => {
    const { history } = await daemon.listChainHistory(args.conversation_id, args.limit);
    const rawJson = JSON.stringify(history, null, 2);
    if (args.envelope) {
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
      content: [{ type: "text", text: rawJson }],
    };
  };
