import type { Services } from "@penumbra/core";

import { sseCallbackStream } from "./_sse.js";

/**
 * GET /conversations/:id/stream
 * SSE endpoint for real-time progress updates for a specific conversation.
 * Immediately flushes cached tokens for the active hop upon connection.
 */
export function conversationStreamRoute(
  _req: Request,
  conversation_id: string,
  services: Services,
): Response {
  return sseCallbackStream({
    start(write) {
      // 1. Flush cached state for the current hop (hop-start + tokens)
      const history = services.conversationStream.getHistory(conversation_id);
      for (const event of history) {
        write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
      }

      // 2. Subscribe to live events
      const off = services.conversationStream.subscribe((convId, event) => {
        if (convId !== conversation_id) return;
        write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
      });

      // Initial comment so clients know the connection is live
      write(": ok\n\n");
      return off;
    },
  });
}
