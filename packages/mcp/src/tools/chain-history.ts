import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const ChainHistoryInputShape = {
  conversation_id: z.string().describe('The conversation ID to query history for.'),
  limit: z.number().optional().default(50).describe('Maximum number of events to return.'),
};

export const chainHistoryHandler = (daemon: DaemonClient) => async (args: { conversation_id: string; limit?: number }) => {
  const { history } = await daemon.listChainHistory(args.conversation_id, args.limit);
  return {
    content: [{ type: 'text', text: JSON.stringify(history, null, 2) }],
  };
};
