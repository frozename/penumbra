import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const WorktreeCleanupInputShape = {
  handoff_id: z.string().min(1).describe('The handoff ID to cleanup the worktree for'),
  force: z.boolean().optional().describe('Whether to force cleanup even if there are uncommitted changes'),
};

export function worktreeCleanupHandler(daemon: DaemonClient) {
  return async (input: any) => {
    const res = await daemon.cleanupWorktree(input.handoff_id, input.force);
    return { content: [{ type: 'text', text: JSON.stringify(res) }] };
  };
}
