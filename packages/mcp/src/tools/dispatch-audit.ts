import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import { makeEnvelopeResult } from "../responses/envelope.js";
import { estimateTokens, truncateToTokens, DEFAULT_BUDGET } from "../responses/budget.js";

export const DispatchAuditInputShape = {
  handoff_id: z
    .string()
    .min(1)
    .describe("The handoff_id whose reliability audit report should be returned."),
  envelope: z
    .boolean()
    .optional()
    .describe(
      "When true, return a token-budgeted envelope with _meta.token_budget + result_bytes instead of the raw payload.",
    ),
};

export function dispatchAuditHandler(daemon: Pick<DaemonClient, "dispatchAudit">) {
  return async (input: { handoff_id: string; envelope?: boolean }) => {
    const audit = await daemon.dispatchAudit(input.handoff_id);
    const rawJson = JSON.stringify(audit, null, 2);
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
