import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";
import { makeEnvelopeResult } from "../responses/envelope.js";
import { estimateTokens, truncateToTokens, DEFAULT_BUDGET } from "../responses/budget.js";

export const SearchInputShape = {
  query: z.string().min(1).describe("Free-text query (FTS5 syntax allowed)"),
  project_id: z.string().nullable().optional(),
  limit: z.number().int().positive().max(100).optional(),
  obs_type: z
    .string()
    .optional()
    .describe(
      "Filter: decision|bugfix|feature|refactor|discovery|change|security_alert|security_note|session",
    ),
  concept: z.string().optional().describe("Substring match against the concepts JSON array"),
  file_path: z.string().optional().describe("Substring match against the file_paths JSON array"),
  dateStart: z.string().optional().describe("ISO date; matched against created_at >="),
  dateEnd: z.string().optional().describe("ISO date; matched against created_at <="),
  tiers: z.array(z.enum(["t1", "t2"])).optional(),
  offset: z.number().int().min(0).optional(),
  envelope: z
    .boolean()
    .optional()
    .describe(
      "When true, return a token-budgeted envelope with _meta.token_budget + result_bytes instead of the raw payload.",
    ),
};

export function searchHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    // `rest` assumes an object input — guaranteed by the registered
    // inputSchema (SearchInputShape) Zod-parsing upstream before this runs.
    const { envelope, ...rest } = (input ?? {}) as Record<string, unknown> & { envelope?: boolean };
    const out = await daemon.memorySearch(rest);
    if (envelope) {
      const rawJson = JSON.stringify(out, null, 2);
      // result_bytes reports the TRUE pre-truncation source size; usedTokens is
      // measured against the (possibly truncated) text actually returned. When
      // truncated, these intentionally describe different payloads — same
      // semantics as the workflow_wait cap (true byte size + truncation flag).
      const resultBytes = Buffer.byteLength(rawJson, "utf8");
      const { text, truncated } = truncateToTokens(rawJson, DEFAULT_BUDGET);
      return makeEnvelopeResult([{ type: "text", text }], {
        usedTokens: estimateTokens(text),
        limitTokens: DEFAULT_BUDGET,
        truncated,
        resultBytes,
      });
    }
    return toTextContent(out);
  };
}
