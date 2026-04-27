import type { Services } from '@penumbra/core';

/**
 * GET /worker/control
 * SSE endpoint for worker control events (e.g. cancellations).
 * Immediately flushes active cancellations upon connection for durable sync.
 */
export async function workerControlRoute(_req: Request, services: Services): Promise<Response> {
  let off: (() => void) | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      // 1. Flush durable state (active cancellations)
      // This ensures that even if a worker was offline when the cancel was
      // requested, it picks it up immediately upon reconnection.
      const pending = services.handoffReader.listActiveCancellations();
      for (const { conversation_id, handoff_id } of pending) {
        controller.enqueue(
          encoder.encode(
            `event: control\ndata: ${JSON.stringify({ type: 'cancel', conversation_id, handoff_id })}\n\n`,
          ),
        );
      }

      // 2. Subscribe to live events
      off = services.workerControl.subscribe((event) => {
        try {
          controller.enqueue(
            encoder.encode(`event: control\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // controller closed; unsubscribe defensively
          off?.();
          off = null;
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      });

      // Initial comment so clients know the connection is live
      controller.enqueue(encoder.encode(': ok\n\n'));

      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          try {
            off?.();
          } catch {
            /* noop */
          }
          off = null;
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      }, 15_000);
    },
    cancel() {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = null;
      try {
        off?.();
      } catch {
        /* noop */
      }
      off = null;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
