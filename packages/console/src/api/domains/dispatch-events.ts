import { DispatchEventsListResponseSchema } from "@penumbra/api-contract";
import { z } from "zod";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = {
  list: "/dispatch/events",
} as const;

type DispatchEventsListResponse = z.infer<typeof DispatchEventsListResponseSchema>;

export interface DispatchEventsSlice {
  list(handoffId: string): Promise<DispatchEventsListResponse>;
}

export function dispatchEventsSlice(t: DaemonTransport): DispatchEventsSlice {
  return {
    list(handoffId: string): Promise<DispatchEventsListResponse> {
      return t.request({
        path: fillPath(PATHS.list),
        query: { handoff_id: handoffId },
        schema: DispatchEventsListResponseSchema,
      });
    },
  };
}
