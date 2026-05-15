import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';
import { chainStartHandler, type ChainStartHandlerOpts } from './chain-start.js';

export const ChainStartSimpleInputShape = {
  initial_agent: z.string().min(1).describe('The agent to receive the first hop of the chain'),
  message: z.string().min(1).describe('The user message that kicks off the chain'),
};

export function chainStartSimpleHandler(daemon: DaemonClient, opts: ChainStartHandlerOpts = {}) {
  const inner = chainStartHandler(daemon, opts);
  return async (input: { initial_agent: string; message: string }) => {
    return inner({
      initial_agent: input.initial_agent,
      message: input.message,
      task_class: 'STANDARD',
      task_type: 'debug_diagnose',
      use_worktree: false,
      max_hops: 2,
      trust_mode: 'config',
    });
  };
}
