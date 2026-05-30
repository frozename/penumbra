import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import { makeEnvelopeResult } from "../responses/envelope.js";
import { estimateTokens, truncateToTokens, DEFAULT_BUDGET } from "../responses/budget.js";

export const ChainGetMessagesInputShape = z.object({
  conversation_id: z.string().describe("The conversation ID to query messages for."),
  types: z.array(z.string()).optional().describe("Optional array of event types to filter by."),
  envelope: z
    .boolean()
    .optional()
    .describe(
      "When true, return a token-budgeted envelope with _meta.token_budget + result_bytes instead of the raw payload.",
    ),
});

export function chainGetMessagesHandler(daemon: DaemonClient) {
  return async (args: z.infer<typeof ChainGetMessagesInputShape>) => {
    try {
      const res = await daemon.getChainMessages(args.conversation_id, args.types);
      if (args.envelope) {
        const rawJson = JSON.stringify(res, null, 2);
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
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to fetch chain messages: ${err.message}` }],
      };
    }
  };
}
