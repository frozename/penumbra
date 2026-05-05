import { toTextContent } from '@nova/mcp-shared';
import { CancelTaskInputSchema } from '@penumbra/core';
import type { DaemonClient } from '../daemon-client.js';

export const TaskCancelInputSchema = CancelTaskInputSchema;
export const TaskCancelInputShape = TaskCancelInputSchema.shape;

export function taskCancelHandler(daemon: Pick<DaemonClient, 'taskCancel'>) {
  return async (input: unknown) => {
    const parsed = TaskCancelInputSchema.parse(input ?? {});
    const out = await daemon.taskCancel(parsed.task_id, { reason: parsed.reason });
    return toTextContent(out);
  };
}
