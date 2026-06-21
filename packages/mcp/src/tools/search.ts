import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

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
};

export function searchHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const out = await daemon.memorySearch(input);
    return toTextContent(out);
  };
}
