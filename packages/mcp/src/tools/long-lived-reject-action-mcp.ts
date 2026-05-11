import { z } from 'zod';
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const LongLivedRejectActionInputShape = {
  action_id: z.string().min(1),
  reason: z.string().optional(),
};

export function longLivedRejectActionHandler(daemon: DaemonClient) {
  return async (input: { action_id: string; reason?: string }) =>
    toTextContent(await daemon.longLivedRejectAction(input.action_id, input.reason));
}
