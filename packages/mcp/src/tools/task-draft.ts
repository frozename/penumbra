import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const TaskDraftListPendingInputShape = {
  latest_event_type: z.enum(['task_draft', 'task_draft_escalation']),
  project_id: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(50).optional(),
};

export function taskDraftListPendingHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = z.object(TaskDraftListPendingInputShape).strict().parse(input);
    const out = await daemon.taskDraftsPending(parsed);
    return toTextContent(out);
  };
}
