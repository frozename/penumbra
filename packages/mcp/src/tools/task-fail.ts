import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { FailTaskInputSchema } from "@penumbra/core";

import type { DaemonClient } from "../daemon-client.js";

export const TaskFailInputSchema = FailTaskInputSchema;
export const TaskFailInputShape = TaskFailInputSchema.shape;

export function taskFailHandler(daemon: Pick<DaemonClient, "taskFail">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = TaskFailInputSchema.parse(input ?? {});
    const out = await daemon.taskFail(parsed.task_id, {
      lease_id: parsed.lease_id,
      reason: parsed.reason,
    });
    return toTextContent(out);
  };
}
