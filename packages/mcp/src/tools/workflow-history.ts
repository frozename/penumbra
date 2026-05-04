import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const WorkflowHistoryInputShape = {
  name: z.string().min(1).describe('Workflow name to fetch history for.'),
};

export function workflowHistoryHandler(daemon: DaemonClient) {
  return async (input: unknown) => toTextContent(await daemon.workflowHistory(input as { name: string }));
}
