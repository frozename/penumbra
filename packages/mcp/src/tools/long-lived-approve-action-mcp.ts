import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const LongLivedApproveActionInputShape = {
  action_id: z.string().min(1),
  decided_by: z.string().min(1).optional(),
};

export function longLivedApproveActionHandler(daemon: DaemonClient) {
  return async (input: { action_id: string; decided_by?: string }) =>
    toTextContent(await daemon.longLivedApproveAction(input.action_id, input.decided_by));
}
