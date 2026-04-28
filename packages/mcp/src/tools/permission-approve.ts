import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const PermissionApproveInputShape = {
  permission_id: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  remember: z.enum(['this_call', 'this_dispatch']).optional().describe('Default: this_call. Use "this_dispatch" to short-circuit subsequent calls of the same tool name within this dispatch.'),
  reason: z.string().optional(),
};

export const permissionApproveHandler = (daemon: DaemonClient) => async (
  args: { permission_id: string; decision: 'approve' | 'reject'; remember?: 'this_call' | 'this_dispatch'; reason?: string },
) => {
  const r = await daemon.approvePermission(args.permission_id, {
    decision: args.decision,
    remember: args.remember,
    reason: args.reason,
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
};
