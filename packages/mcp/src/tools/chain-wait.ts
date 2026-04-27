import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const ChainWaitInputShape = {
  conversation_id: z.string().describe('The conversation ID to wait for.'),
  timeout_ms: z.number().optional().default(60000).describe('Timeout in ms (default 60000).'),
};

export const chainWaitHandler = (daemon: DaemonClient) => async (args: { conversation_id: string; timeout_ms?: number }) => {
  const timeout = args.timeout_ms ?? 60000;
  const start = Date.now();
  let interval = 200;
  let lastHandoffId: string | undefined;

  while (Date.now() - start < timeout) {
    try {
      const { handoff } = await daemon.getLatestHandoff(args.conversation_id);
      lastHandoffId = handoff.handoff_id;
      if (handoff.status === 'completed' || handoff.status === 'failed' || handoff.status === 'rejected') {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            status: handoff.status,
            last_handoff_id: lastHandoffId,
            error: handoff.error_message ?? undefined,
          }, null, 2) }]
        };
      }
    } catch (err: any) {
      // 404 means no handoffs yet; we keep polling.
      // Other errors we also swallow to keep polling until timeout.
    }
    
    await new Promise(r => setTimeout(r, interval));
    interval = Math.min(interval * 1.5, 2000);
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({
      status: 'timeout',
      last_handoff_id: lastHandoffId,
    }, null, 2) }]
  };
};
