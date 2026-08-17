import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const TaskCommentGhInputSchema = z
  .object({
    task_id: z.string().min(1),
    body: z.string().min(1),
  })
  .strict();
export const TaskCommentGhInputShape = TaskCommentGhInputSchema.shape;

export function taskCommentGhHandler(daemon: Pick<DaemonClient, "taskCommentGh">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = TaskCommentGhInputSchema.parse(input ?? {});
    const out = await daemon.taskCommentGh(parsed.task_id, { body: parsed.body });
    return toTextContent(out);
  };
}
