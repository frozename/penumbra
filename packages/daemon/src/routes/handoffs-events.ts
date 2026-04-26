import type { Services } from '@penumbra/core';

export async function handoffsEventsRoute(_req: Request, services: Services): Promise<Response> {
  // Hold the unsubscribe in the underlying-source closure so cancel() can reach
  // it without going through `this` (which is not the controller).
  let off: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      off = services.handoffEvents.subscribe((row) => {
        try {
          controller.enqueue(encoder.encode(`event: handoff\ndata: ${JSON.stringify(row)}\n\n`));
        } catch {
          // controller closed; unsubscribe defensively
          off?.();
          off = null;
        }
      });
      // Initial comment so clients know the connection is live (some HTTP buffers need a flush).
      controller.enqueue(encoder.encode(': ok\n\n'));
    },
    cancel() {
      try { off?.(); } catch { /* noop */ }
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