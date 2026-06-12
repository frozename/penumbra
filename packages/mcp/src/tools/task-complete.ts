import { toTextContent } from "@nova/mcp-shared";
import { z } from "zod";
import { CompleteTaskInputSchema as CoreCompleteTaskInputSchema } from "@penumbra/core";
import type { DaemonClient } from "../daemon-client.js";

// lease_id is optional at the tool layer: maestro principals complete tasks
// lease-lessly, and a required field here would 400 before the daemon's
// principal-aware gate ever ran.
const TaskCompleteToolSchema = CoreCompleteTaskInputSchema.extend({
  lease_id: z.string().optional(),
});
export const TaskCompleteInputShape = TaskCompleteToolSchema.shape;

export function taskCompleteHandler(daemon: Pick<DaemonClient, "taskComplete">) {
  return async (input: unknown) => {
    const parsed = TaskCompleteToolSchema.parse(input ?? {});
    const out = await daemon.taskComplete(parsed.task_id, {
      lease_id: parsed.lease_id,
      result_summary: parsed.result_summary,
      result_artifacts: parsed.result_artifacts,
      chain_id: parsed.chain_id,
      review_verdict: parsed.review_verdict,
    });
    return toTextContent(out);
  };
}
