import { toTextContent } from '@nova/mcp-shared';
import { TaskKindSchema, TaskStatusSchema } from '@penumbra/core';
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const TaskListInputSchema = z.object({
  status: TaskStatusSchema.optional(),
  kind: TaskKindSchema.optional(),
  eligible_for: z.string().min(1).optional(),
  parent_task_id: z.string().min(1).optional(),
  origin: z.string().min(1).optional(),
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
}).strict();
export const TaskListInputShape = TaskListInputSchema.shape;

export function taskListHandler(daemon: Pick<DaemonClient, 'taskList'>) {
  return async (input: unknown) => {
    const parsed = TaskListInputSchema.parse(input ?? {});
    const out = await daemon.taskList(parsed);
    return toTextContent(out);
  };
}
