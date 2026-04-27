import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const ChainStartInputShape = {
  initial_agent: z.string().min(1).describe('The agent to receive the first hop of the chain'),
  message: z.string().min(1).describe('The user message that kicks off the chain'),
  conversation_id: z.string().min(1).optional().describe('Optional caller-supplied conversation id'),
  project_id: z.string().min(1).nullable().optional().describe('Optional project scope'),
  max_hops: z.number().int().positive().optional().describe('Maximum hop count (default 8)'),
  trust_mode: z.enum(['all', 'config']).optional().describe('all = auto-approve every edge; config = consult auto_approve_to'),
  use_worktree: z.boolean().optional().describe('Whether to spawn the worker in an isolated git worktree (default true)'),
};

export function chainStartHandler(daemon: DaemonClient) {
  return async (input: any) => {
    // Forward only the keys the caller actually supplied; the daemon route fills
    // sensible defaults for missing fields.
    const body: Record<string, unknown> = {
      initial_agent: input.initial_agent,
      message: input.message,
    };
    if (input.conversation_id !== undefined) body.conversation_id = input.conversation_id;
    if (input.project_id !== undefined && input.project_id !== null) body.project_id = input.project_id;
    if (input.max_hops !== undefined) body.max_hops = input.max_hops;
    if (input.trust_mode !== undefined) body.trust_mode = input.trust_mode;
    if (input.use_worktree !== undefined) body.use_worktree = input.use_worktree;
    const res = await daemon.startChain(body as any);
    return { content: [{ type: 'text', text: JSON.stringify(res) }] };
  };
}
