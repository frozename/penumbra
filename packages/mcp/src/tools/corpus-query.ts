import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const CorpusQueryInputShape = {
  name: z.string().min(1),
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
};

export function corpusQueryHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> =>
    toTextContent(await daemon.corpusQuery(input));
}
