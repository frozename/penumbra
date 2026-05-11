import { z } from 'zod';
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const LongLivedApproveActionInputShape = {
  action_id: z.string().min(1),
};

export function longLivedApproveActionHandler(daemon: DaemonClient) {
  return async (input: { action_id: string }) => toTextContent(await daemon.longLivedApproveAction(input.action_id));
}
