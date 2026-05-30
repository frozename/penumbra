import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import { makeEnvelopeResult } from "../responses/envelope.js";
import { estimateTokens, truncateToTokens, DEFAULT_BUDGET } from "../responses/budget.js";

export const ChainListAgentsInputShape = {
  envelope: z
    .boolean()
    .optional()
    .describe(
      "When true, return a token-budgeted envelope with _meta.token_budget + result_bytes instead of the raw payload.",
    ),
};

export const chainListAgentsHandler =
  (daemon: DaemonClient) => async (args: { envelope?: boolean }) => {
    const { agents } = await daemon.listChainAgents();
    const rawJson = JSON.stringify({ agents }, null, 2);
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
