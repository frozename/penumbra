import { toTextContent } from '@nova/mcp-shared';
import { HeartbeatTaskInputSchema } from '@penumbra/core';
import type { DaemonClient } from '../daemon-client.js';

export const TaskHeartbeatInputSchema = HeartbeatTaskInputSchema;
export const TaskHeartbeatInputShape = TaskHeartbeatInputSchema.shape;

export function taskHeartbeatHandler(daemon: Pick<DaemonClient, 'taskHeartbeat'>) {
  return async (input: unknown) => {
    const parsed = TaskHeartbeatInputSchema.parse(input ?? {});
    const out = await daemon.taskHeartbeat(parsed.task_id, { lease_id: parsed.lease_id });
    return toTextContent(out);
  };
}
