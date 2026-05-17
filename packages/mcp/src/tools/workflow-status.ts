import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const WorkflowStatusInputShape = {
  workflow_run_id: z.string().min(1).describe('Workflow run id returned by workflow_run.'),
};

export const WorkflowWaitInputShape = {
  workflow_run_id: z.string().min(1).describe('Workflow run id returned by workflow_run.'),
  timeout_ms: z.number().int().positive().optional().default(300000).describe('Timeout in ms (default 300000).'),
};

export function workflowStatusHandler(daemon: DaemonClient) {
  return async (input: { workflow_run_id: string }) => toTextContent(await daemon.workflowStatus(input));
}

export function workflowWaitHandler(daemon: DaemonClient) {
  return async (input: { workflow_run_id: string; timeout_ms?: number }) =>
    toTextContent(await daemon.workflowWait(input));
}
