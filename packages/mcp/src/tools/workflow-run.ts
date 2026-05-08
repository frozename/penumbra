import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const WorkflowRunInputShape = {
  name: z.string().min(1).describe('Workflow name from `workflow.list`.'),
  cwd: z.string().optional().describe('Optional cwd override for project resolution.'),
  session_id: z
    .string()
    .min(1)
    .optional()
    .describe('Optional Claude Code session id; scopes recall sources that use sessionStart (e.g., dispatch_events).'),
};

export function workflowRunHandler(daemon: DaemonClient) {
  return async (input: unknown) =>
    toTextContent(await daemon.workflowRun(input as { name: string; cwd?: string; session_id?: string }));
}
