import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const TaskDraftListPendingInputShape = {
  latest_event_type: z.enum(['task_draft', 'task_draft_escalation']),
  project_id: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
};

export const TaskDraftListPendingEscalationsInputShape = {
  project_id: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
};

export function taskDraftListPendingHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = z.object(TaskDraftListPendingInputShape).strict().parse(input);
    const out = await daemon.taskDraftsPending(parsed);
    return toTextContent(out);
  };
}

export function taskDraftListPendingEscalationsHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = z.object(TaskDraftListPendingEscalationsInputShape).strict().parse(input);
    const out = await daemon.taskDraftsPendingEscalations(parsed);
    return toTextContent(out);
  };
}
