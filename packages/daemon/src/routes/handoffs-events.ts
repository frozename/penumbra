import type { Services } from "@penumbra/core";

import { sseCallbackStream } from "./_sse.js";

export function handoffsEventsRoute(_req: Request, services: Services): Response {
  return sseCallbackStream({
    start(write) {
      const off = services.handoffEvents.subscribe((row) => {
        write(`event: handoff\ndata: ${JSON.stringify(row)}\n\n`);
      });
      // Initial comment so clients know the connection is live (some HTTP buffers need a flush).
      write(": ok\n\n");
      return off;
    },
  });
}
