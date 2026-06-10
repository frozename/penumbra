import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import { RecallRequestSchema } from "@penumbra/core";
import type { DaemonClient } from "../daemon-client.js";
import { sliceSurrogateSafe } from "../responses/budget.js";

export const RecallInputShape = {
  query: z.string().min(1),
  project_id: z.string().nullable().optional(),
  limit: z.number().int().positive().max(200).optional(),
  include_raw: z.boolean().optional(),
  min_score: z.number().min(0).max(1).optional(),
  body_max_chars: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Maximum characters to return per hit body (default 600)."),
  session_id: z.string().optional().describe("Limit results to a single chain or session id."),
  event_types: z
    .array(z.string())
    .optional()
    .describe(
      'Limit t0 results to these event_type values (e.g. ["agent-thought","agent-response"]).',
    ),
  file_path: z
    .string()
    .optional()
    .describe(
      "Restrict t0 results to events that touched this file path (joined via t0_file_refs).",
    ),
};

const RecallSchema = z.object(RecallInputShape).strict();
const DEFAULT_BODY_MAX_CHARS = 600;

/**
 * Unlike observeHandler, recall requires no server-side identity injection —
 * RecallRequestSchema fields are all LLM-addressable or have schema defaults.
 */
export function recallHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = RecallSchema.parse(input);
    const request = RecallRequestSchema.parse({
      ...parsed,
      // Explicit `?? null` guards against RecallRequestSchema losing its .default(null) later.
      project_id: parsed.project_id ?? null,
    });
    const r = await daemon.recall(request);
    const bodyMaxChars = parsed.body_max_chars ?? DEFAULT_BODY_MAX_CHARS;
    if (Array.isArray(r?.results)) {
      for (const hit of r.results) {
        if (typeof hit?.body === "string" && hit.body.length > bodyMaxChars) {
          // Surrogate-safe: a naive slice can split an astral codepoint (emoji)
          // and leave a lone high surrogate that strict JSON decoders reject.
          hit.body = sliceSurrogateSafe(hit.body, bodyMaxChars);
        }
      }
    }
    return toTextContent(r);
  };
}
