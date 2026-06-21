import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const TaskGetInputSchema = z
  .object({
    task_id: z.string().min(1),
    include: z.array(z.enum(["lease", "events", "descendants"])).optional(),
  })
  .strict();
export const TaskGetInputShape = TaskGetInputSchema.shape;

export function taskGetHandler(daemon: Pick<DaemonClient, "taskGet">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = TaskGetInputSchema.parse(input ?? {});
    const out = await daemon.taskGet(parsed.task_id, { include: parsed.include });
    return toTextContent(out);
  };
}
