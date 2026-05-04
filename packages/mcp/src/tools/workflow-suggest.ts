import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const WorkflowSuggestInputShape = {
  now: z.string().optional().describe('Optional ISO8601 override for state-threshold evaluation.'),
};

export function workflowSuggestHandler(daemon: DaemonClient) {
  return async (input: unknown) => toTextContent(await daemon.workflowSuggest(input as { now?: string }));
}
