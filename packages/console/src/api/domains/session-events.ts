import { type SessionEvent, SessionEventSchema } from "@penumbra/api-contract";
import { z } from "zod";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = { list: "/session-events" } as const;

const SessionEventsEnvelopeSchema = z
  .object({
    events: z.array(z.unknown()),
  })
  .loose();

export type SessionEventParseResult =
  | { ok: true; event: SessionEvent }
  | { ok: false; raw: unknown; reason: string };

export interface SessionEventsListTolerantResponse {
  events: SessionEventParseResult[];
}

export interface SessionEventsSlice {
  list(query?: {
    session_id?: string;
    kind_prefix?: string;
    since?: string;
    limit?: number;
  }): Promise<SessionEventsListTolerantResponse>;
}

export function parseSessionEventRow(raw: unknown): SessionEventParseResult {
  const parsed = SessionEventSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, event: parsed.data };
  }
  return {
    ok: false,
    raw,
    reason: parsed.error.issues.map((issue) => issue.message).join("; "),
  };
}

export function sessionEventsSlice(t: DaemonTransport): SessionEventsSlice {
  return {
    list(query?: {
      session_id?: string;
      kind_prefix?: string;
      since?: string;
      limit?: number;
    }): Promise<SessionEventsListTolerantResponse> {
      return t
        .request({ path: fillPath(PATHS.list), query, schema: SessionEventsEnvelopeSchema })
        .then((raw) => ({ events: raw.events.map(parseSessionEventRow) }));
    },
  };
}
