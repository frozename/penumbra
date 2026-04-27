import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const WorktreeListInputShape = {};

export function worktreeListHandler(daemon: DaemonClient) {
  return async () => {
    const res = await daemon.listWorktrees();
    return { content: [{ type: 'text', text: JSON.stringify(res) }] };
  };
}
