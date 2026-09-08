import {
  type RegistrarDetail,
  RegistrarDetailSchema,
  type RegistrarEvent,
  type RegistrarEventInput,
  RegistrarEventSchema,
  type RegistrarEventsListResponse,
  RegistrarEventsListResponseSchema,
  type RegistrarListResponse,
  RegistrarListResponseSchema,
} from "@penumbra/api-contract";
import { z } from "zod";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = {
  list: "/registrar",
  get: "/registrar/:id",
  events: "/registrar/:id/events",
} as const;

export type RegistrarEventsResponse = RegistrarEventsListResponse;

export interface RegistrarSlice {
  list(): Promise<RegistrarListResponse>;
  get(id: string): Promise<RegistrarDetail>;
  events(id: string): Promise<RegistrarEventsListResponse>;
  appendEvent(id: string, input: RegistrarEventInput): Promise<{ event: RegistrarEvent }>;
}

export function registrarSlice(t: DaemonTransport): RegistrarSlice {
  return {
    list(): Promise<RegistrarListResponse> {
      return t.request({ path: fillPath(PATHS.list), schema: RegistrarListResponseSchema });
    },
    get(id: string): Promise<RegistrarDetail> {
      return t.request({ path: fillPath(PATHS.get, { id }), schema: RegistrarDetailSchema });
    },
    events(id: string): Promise<RegistrarEventsListResponse> {
      return t.request({
        path: fillPath(PATHS.events, { id }),
        schema: RegistrarEventsListResponseSchema,
      });
    },
    appendEvent(id: string, input: RegistrarEventInput): Promise<{ event: RegistrarEvent }> {
      return t.request({
        method: "POST",
        path: fillPath(PATHS.events, { id }),
        body: input,
        schema: RegistrarEventAppendResponseSchema,
      });
    },
  };
}

const RegistrarEventAppendResponseSchema = z.object({ event: RegistrarEventSchema }).loose();
