import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import { DaemonHttpError } from "../daemon-client.js";
import { makeEnvelopeResult } from "../responses/envelope.js";
import { estimateTokens, truncateToTokens, DEFAULT_BUDGET } from "../responses/budget.js";

export const ChainGetResponseInputShape = {
  conversation_id: z.string().describe("The conversation ID to query responses for."),
  which: z
    .enum(["final", "all"])
    .optional()
    .default("final")
    .describe("Whether to return only the final response or all responses in chronological order."),
  envelope: z
    .boolean()
    .optional()
    .describe(
      "When true, return a token-budgeted envelope with _meta.token_budget + result_bytes instead of the formatted payload.",
    ),
};
import { formatChainGetResponse, wrapWithSummary } from "../format-summary.js";

export const chainGetResponseHandler =
  (daemon: DaemonClient) =>
  async (args: { conversation_id: string; which?: "final" | "all"; envelope?: boolean }) => {
    try {
      const payload = await daemon.getChainResponses(args.conversation_id, args.which);
      if (args.envelope) {
        const rawJson = JSON.stringify(payload, null, 2);
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
            type: "text",
            text: wrapWithSummary(formatChainGetResponse(payload), payload),
          },
        ],
      };
    } catch (err) {
      if (isNotFound(err)) {
        const payload = notFoundBody(err);
        return {
          content: [
            {
              type: "text",
              text: wrapWithSummary("◑ chain_get_response  not found", payload),
            },
          ],
        };
      }
      throw err;
    }
  };

function isNotFound(err: unknown): err is DaemonHttpError {
  return err instanceof DaemonHttpError && err.status === 404;
}

function notFoundBody(err: DaemonHttpError | { body?: unknown }) {
  const body = "body" in err ? err.body : undefined;
  if (typeof body === "object" && body !== null && "error" in body) {
    return body;
  }
  return { error: { code: "not_found", message: "no chain events found for conversation" } };
}
