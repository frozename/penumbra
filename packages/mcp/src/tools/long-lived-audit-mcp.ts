import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const LongLivedAuditInputShape = {
  id: z.string().min(1),
  since: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
};

export function longLivedAuditHandler(daemon: DaemonClient) {
  return async (input: {
    id: string;
    since?: number;
    limit?: number;
  }): Promise<TextContentEnvelope> =>
    toTextContent(await daemon.longLivedAudit(input.id, input.since, input.limit));
}
