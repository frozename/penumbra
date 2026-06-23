import type { Services } from "@penumbra/core";

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
  let off: (() => void) | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const encoder = new TextEncoder();

      // 1. Flush cached state for the current hop (hop-start + tokens)
      const history = services.conversationStream.getHistory(conversation_id);
      for (const event of history) {
        controller.enqueue(encoder.encode(`event: progress\ndata: ${JSON.stringify(event)}\n\n`));
      }

      // 2. Subscribe to live events
      off = services.conversationStream.subscribe((convId, event) => {
        if (convId !== conversation_id) return;
        try {
          controller.enqueue(encoder.encode(`event: progress\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          // controller closed; unsubscribe defensively
          off?.();
          off = null;
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      });

      // Initial comment so clients know the connection is live
      controller.enqueue(encoder.encode(": ok\n\n"));

      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
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
    cancel(): void {
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
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
