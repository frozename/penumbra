import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { resolveToolOrigin } from "../tool-origin.js";

export const TaskNextInputSchema = z
  .object({
    agent_id: z.string().min(1),
    tags: z.array(z.string()).optional(),
    max_cost_cents: z.number().nonnegative().optional(),
  })
  .strict();
export const TaskNextInputShape = TaskNextInputSchema.shape;

export function taskNextHandler(daemon: Pick<DaemonClient, "taskNext">) {
  return async (input: unknown, extra: unknown): Promise<TextContentEnvelope> => {
    const parsed = TaskNextInputSchema.parse(input ?? {});
    const origin = resolveToolOrigin(extra);
    const out = await daemon.taskNext(parsed, origin ? { origin } : {});
    return toTextContent(out);
  };
}
