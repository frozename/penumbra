import { toTextContent } from '@nova/mcp-shared';
import { CompleteTaskInputSchema } from '@penumbra/core';
import type { DaemonClient } from '../daemon-client.js';

export const TaskCompleteInputSchema = CompleteTaskInputSchema;
export const TaskCompleteInputShape = TaskCompleteInputSchema.shape;

export function taskCompleteHandler(daemon: Pick<DaemonClient, 'taskComplete'>) {
  return async (input: unknown) => {
    const parsed = TaskCompleteInputSchema.parse(input ?? {});
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
