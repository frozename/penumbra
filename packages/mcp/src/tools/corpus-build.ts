import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const CorpusBuildInputShape = {
  name: z
    .string()
    .min(1)
    .max(64)
    .describe("Unique corpus name; rebuilding by name replaces members."),
  description: z.string().max(280).optional(),
  filter: z.object({
    project_id: z.string().nullable().optional(),
    obs_type: z.string().optional(),
    concept: z.string().optional(),
    file_path: z.string().optional(),
    dateStart: z.string().optional(),
    dateEnd: z.string().optional(),
    limit: z.number().int().positive().max(2000).optional(),
  }),
};

export function corpusBuildHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> =>
    toTextContent(await daemon.corpusBuild(input));
}
