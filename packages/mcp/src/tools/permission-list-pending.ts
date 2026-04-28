import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const PermissionListPendingInputShape = {
  conversation_id: z.string().optional().describe('Filter to a single conversation.'),
  parent_handoff_id: z.string().optional().describe('Filter to a single dispatch.'),
  status: z.string().optional().describe('Comma-separated status filter (default: pending). Allowed: pending,approved,rejected,expired.'),
};

import { formatPermissionListPending, wrapWithSummary } from '../format-summary.js';

export const permissionListPendingHandler = (daemon: DaemonClient) => async (
  args: { conversation_id?: string; parent_handoff_id?: string; status?: string },
) => {
  const payload = await daemon.listPermissions({
    status: args.status,
    conversation_id: args.conversation_id,
    parent_handoff_id: args.parent_handoff_id,
  });
  return {
    content: [{
      type: 'text' as const,
      text: wrapWithSummary(formatPermissionListPending(payload), payload),
    }]
  };
};
