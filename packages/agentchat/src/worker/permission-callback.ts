import type { PermissionDecision, ToolCallContext } from '../sdk/adapter.js';

export function createPermissionCallback(
  trustMode: 'all' | 'config' = 'all',
): (toolCall: ToolCallContext) => Promise<PermissionDecision> {
  return async (_toolCall: ToolCallContext): Promise<PermissionDecision> => {
    if (trustMode === 'all') return 'approve';
    return 'reject';
  };
}
