import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const ChainGetResponseInputShape = {
  conversation_id: z.string().describe('The conversation ID to query responses for.'),
  which: z.enum(['final', 'all']).optional().default('final').describe('Whether to return only the final response or all responses in chronological order.'),
};

export const chainGetResponseHandler = (daemon: DaemonClient) => async (args: { conversation_id: string; which?: 'final' | 'all' }) => {
  const { responses } = await daemon.getChainResponses(args.conversation_id, args.which);
  return {
    content: [{ type: 'text', text: JSON.stringify({ responses }, null, 2) }],
  };
};
