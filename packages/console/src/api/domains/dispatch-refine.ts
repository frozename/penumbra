import {
  DispatchRefineRequestSchema,
  type DispatchRefineResponse,
  DispatchRefineResponseSchema,
} from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { DaemonContractError } from "../errors.js";
import { fillPath } from "../paths.js";

export const PATHS = {
  refine: "/dispatch/refine",
} as const;

export interface DispatchRefineSlice {
  refine(message: string): Promise<DispatchRefineResponse>;
}

export function dispatchRefineSlice(t: DaemonTransport): DispatchRefineSlice {
  return {
    refine(message: string): Promise<DispatchRefineResponse> {
      const parsed = DispatchRefineRequestSchema.safeParse({ message });
      if (!parsed.success) {
        throw new DaemonContractError({
          url: fillPath(PATHS.refine),
          issues: parsed.error.issues,
          rawBody: { message },
        });
      }
      return t.request({
        method: "POST",
        path: fillPath(PATHS.refine),
        body: parsed.data,
        schema: DispatchRefineResponseSchema,
      });
    },
  };
}
