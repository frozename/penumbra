import type { Services } from "@penumbra/core";
import type { EmittedPermissionEvent } from "@penumbra/core";

import { json } from "./_helpers.js";
function formatSse(evt: EmittedPermissionEvent): string {
  return `event: ${evt.kind}\nid: ${evt.permission_id}:${evt.seq}\ndata: ${JSON.stringify(evt.payload)}\n\n`;
}

function parseLastEventSeq(header: string | null): number | null {
  if (!header) return null;
  // Format: "seq:<n>" — uses a prefix so future event-id schemes can co-exist.
  const m = /^seq:(\d+)$/.exec(header);
  if (!m) return null;
  return Number(m[1]);
}

export async function permissionsEventsRoute(req: Request, services: Services): Promise<Response> {
  let off: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const lastSeq = parseLastEventSeq(req.headers.get("last-event-id"));

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      // Replay missed events first if Last-Event-ID was supplied.
      if (lastSeq !== null) {
        const replay = services.permissionEvents.replaySince(lastSeq);
        if (replay === null) {
          // Ring buffer evicted — signal client to resync via per-id GET.
          controller.enqueue(encoder.encode(": resync\n\n"));
        } else {
          for (const evt of replay) {
            controller.enqueue(encoder.encode(formatSse(evt)));
          }
        }
      } else {
        controller.enqueue(encoder.encode(": ok\n\n"));
      }

      off = services.permissionEvents.subscribe((evt) => {
        try {
          controller.enqueue(encoder.encode(formatSse(evt)));
        } catch {
          off?.();
          off = null;
          if (keepalive) clearInterval(keepalive);
          keepalive = null;
        }
      });

      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          off?.();
          off = null;
          if (keepalive) clearInterval(keepalive);
          keepalive = null;
        }
      }, 15_000);
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
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
