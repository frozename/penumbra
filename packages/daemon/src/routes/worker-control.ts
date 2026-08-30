import type { Services } from "@penumbra/core";

import { sseCallbackStream } from "./_sse.js";

/**
 * GET /worker/control
 * SSE endpoint for worker control events (e.g. cancellations).
 * Immediately flushes active cancellations upon connection for durable sync.
 */
export function workerControlRoute(_req: Request, services: Services): Response {
  return sseCallbackStream({
    start(write) {
      // 1. Flush durable state (active cancellations)
      // This ensures that even if a worker was offline when the cancel was
      // requested, it picks it up immediately upon reconnection.
      const pending = services.handoffReader.listActiveCancellations();
      for (const { conversation_id, handoff_id } of pending) {
        write(
          `event: control\ndata: ${JSON.stringify({ type: "cancel", conversation_id, handoff_id })}\n\n`,
        );
      }

      // 2. Subscribe to live events
      const off = services.workerControl.subscribe((event) => {
        write(`event: control\ndata: ${JSON.stringify(event)}\n\n`);
      });

      // Initial comment so clients know the connection is live
      write(": ok\n\n");
      return off;
    },
  });
}
