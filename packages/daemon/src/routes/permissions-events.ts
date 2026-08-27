import type { EmittedPermissionEvent, Services } from "@penumbra/core";

import { sseCallbackStream } from "./_sse.js";

function formatSse(evt: EmittedPermissionEvent): string {
  return `event: ${evt.kind}\nid: ${evt.permission_id}:${String(evt.seq)}\ndata: ${JSON.stringify(evt.payload)}\n\n`;
}

function parseLastEventSeq(header: string | null): number | null {
  if (!header) return null;
  // Format: "seq:<n>" — uses a prefix so future event-id schemes can co-exist.
  const m = /^seq:(\d+)$/.exec(header);
  if (!m) return null;
  return Number(m[1]);
}

export function permissionsEventsRoute(req: Request, services: Services): Response {
  const lastSeq = parseLastEventSeq(req.headers.get("last-event-id"));

  return sseCallbackStream({
    start(write) {
      // Replay missed events first if Last-Event-ID was supplied.
      if (lastSeq !== null) {
        const replay = services.permissionEvents.replaySince(lastSeq);
        if (replay === null) {
          // Ring buffer evicted — signal client to resync via per-id GET.
          write(": resync\n\n");
        } else {
          for (const evt of replay) {
            write(formatSse(evt));
          }
        }
      } else {
        write(": ok\n\n");
      }

      const off = services.permissionEvents.subscribe((evt) => {
        write(formatSse(evt));
      });
      return off;
    },
  });
}
