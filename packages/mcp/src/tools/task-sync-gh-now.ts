import { toTextContent } from "@nova/mcp-shared";
import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";

export const TaskSyncGhNowInputSchema = z
  .object({
    task_id: z.string().min(1).optional(),
  })
  .strict();
export const TaskSyncGhNowInputShape = TaskSyncGhNowInputSchema.shape;

export function taskSyncGhNowHandler(daemon: Pick<DaemonClient, "taskSyncGhNow">) {
  return async (input: unknown) => {
    const parsed = TaskSyncGhNowInputSchema.parse(input ?? {});
    const out = await daemon.taskSyncGhNow(parsed.task_id ? { task_id: parsed.task_id } : {});
    return toTextContent(out);
  };
}
