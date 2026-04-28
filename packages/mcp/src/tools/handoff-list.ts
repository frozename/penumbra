import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const ListHandoffsInputShape = {
  conversation_id: z.string().optional(),
};

import { formatHandoffListPending, wrapWithSummary } from '../format-summary.js';

export function listHandoffsHandler(daemon: DaemonClient) {
  return async (input: { conversation_id?: string }) => {
    const r = await daemon.listPendingHandoffs(input.conversation_id ? { conversation_id: input.conversation_id } : {});
    return {
      content: [{
        type: 'text' as const,
        text: wrapWithSummary(formatHandoffListPending(r), r.handoffs),
      }],
    };
  };
}
