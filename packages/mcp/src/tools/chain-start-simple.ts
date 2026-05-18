import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';
import { chainStartHandler, type ChainStartHandlerOpts } from './chain-start.js';

export const ChainStartSimpleInputShape = {
  initial_agent: z.string().min(1).describe('The agent to receive the first hop of the chain'),
  message: z.string().min(1).describe('The user message that kicks off the chain'),
  project_id: z.string().min(1).nullable().optional().describe('Optional project scope'),
  dispatch_kind: z.enum(['long_lived_tick', 'workflow']).optional().describe('Optional dispatch envelope'),
  long_lived_tick_id: z.string().min(1).nullable().optional().describe('Optional long-lived tick id'),
  long_lived_agent_id: z.string().min(1).nullable().optional().describe('Optional long-lived agent id'),
  workflow_run_id: z.string().min(1).nullable().optional().describe('Optional workflow run id'),
};

export function chainStartSimpleHandler(daemon: DaemonClient, opts: ChainStartHandlerOpts = {}) {
  const inner = chainStartHandler(daemon, opts);
  return async (input: {
    initial_agent: string;
    message: string;
    project_id?: string | null;
    dispatch_kind?: 'long_lived_tick' | 'workflow';
    long_lived_tick_id?: string | null;
    long_lived_agent_id?: string | null;
    workflow_run_id?: string | null;
  }) => {
    return inner({
      initial_agent: input.initial_agent,
      message: input.message,
      project_id: input.project_id,
      dispatch_kind: input.dispatch_kind,
      long_lived_tick_id: input.long_lived_tick_id,
      long_lived_agent_id: input.long_lived_agent_id,
      workflow_run_id: input.workflow_run_id,
      task_class: 'STANDARD',
      task_type: 'debug_diagnose',
      use_worktree: false,
      max_hops: 2,
      trust_mode: 'config',
    });
  };
}
