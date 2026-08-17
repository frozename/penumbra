import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { WorkingMemorySchema } from "@penumbra/core/long-lived/types";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const LongLivedStateSetInputShape = {
  id: z.string().min(1),
  partial: z
    .object({
      intent_summary: z.string().optional(),
      working_memory: WorkingMemorySchema.optional(),
    })
    .refine((a) => a.intent_summary !== undefined || a.working_memory !== undefined, {
      message: "at least one of intent_summary or working_memory required",
    }),
};

export function longLivedStateSetHandler(daemon: DaemonClient) {
  return async (input: {
    id: string;
    partial: { intent_summary?: string; working_memory?: unknown };
  }): Promise<TextContentEnvelope> =>
    toTextContent(await daemon.longLivedStateSet(input.id, input.partial));
}
