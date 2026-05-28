import { toTextContent } from "@nova/mcp-shared";
import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";

export const TaskUnlinkGhInputSchema = z
  .object({
    task_id: z.string().min(1),
  })
  .strict();
export const TaskUnlinkGhInputShape = TaskUnlinkGhInputSchema.shape;

export function taskUnlinkGhHandler(daemon: Pick<DaemonClient, "taskUnlinkGh">) {
  return async (input: unknown) => {
    const parsed = TaskUnlinkGhInputSchema.parse(input ?? {});
    const out = await daemon.taskUnlinkGh(parsed.task_id);
    return toTextContent(out);
  };
}
