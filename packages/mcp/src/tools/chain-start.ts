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
  task_type: z.enum([
    'plan_refine',
    'implement_small',
    'implement_substantial',
    'review_adversarial',
    'docs_mechanical',
    'debug_diagnose',
    'smoke_test',
    'health_check',
    'unknown',
  ]).optional().describe('Optional task type hint for agent performance routing'),
  parent_handoff_id: z.string().min(1).optional().describe(
    'Optional handoff ID this dispatch is spawned from. Used by ACP agents calling chain.start during their turn so penumbra can enforce a recursion depth cap. Omit for user-initiated dispatches.'
  ),
};

import { formatChainStart, wrapWithSummary } from '../format-summary.js';

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
    if (input.task_type !== undefined) body.task_type = input.task_type;
    if (input.parent_handoff_id !== undefined) body.parent_handoff_id = input.parent_handoff_id;
    const res = await daemon.startChain(body as any);
    return {
      content: [{
        type: 'text',
        text: wrapWithSummary(
          formatChainStart({
            ...res,
            agent: input.initial_agent,
            trust_mode: input.trust_mode,
          }),
          res
        )
      }]
    };
  };
}
