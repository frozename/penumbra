import {
  type RegistrarDetail,
  RegistrarDetailSchema,
  type RegistrarEvent,
  type RegistrarEventInput,
  RegistrarEventInputSchema,
  RegistrarEventSchema,
  type RegistrarEventsListResponse,
  RegistrarEventsListResponseSchema,
  type RegistrarListResponse,
  RegistrarListResponseSchema,
} from "@penumbra/api-contract";
import { z } from "zod";

import type { DaemonTransport } from "../transport.js";

import { DaemonContractError } from "../errors.js";
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
    async appendEvent(id: string, input: RegistrarEventInput): Promise<{ event: RegistrarEvent }> {
      const parsed = RegistrarEventInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new DaemonContractError({
          url: fillPath(PATHS.events, { id }),
          issues: parsed.error.issues,
          rawBody: input,
        });
      }
      return await t.request({
        method: "POST",
        path: fillPath(PATHS.events, { id }),
        body: parsed.data,
        schema: RegistrarEventAppendResponseSchema,
      });
    },
  };
}

const RegistrarEventAppendResponseSchema = z.object({ event: RegistrarEventSchema }).loose();
