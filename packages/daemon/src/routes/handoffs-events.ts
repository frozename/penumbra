import type { Services } from '@penumbra/core';

export async function handoffsEventsRoute(_req: Request, services: Services): Promise<Response> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const off = services.handoffEvents.subscribe((row) => {
        try {
          controller.enqueue(encoder.encode(`event: handoff\ndata: ${JSON.stringify(row)}\n\n`));
        } catch {
          // controller closed; unsubscribe defensively
          off();
        }
      });
      // Initial comment so clients know the connection is live (some HTTP buffers need a flush).
      controller.enqueue(encoder.encode(': ok\n\n'));
      // Cleanup is owned by the stream's cancel() below.
      (controller as any).__off = off;
    },
    cancel() {
      const off = (this as any).__off as (() => void) | undefined;
      try { off?.(); } catch { /* noop */ }
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