import { type HealthResponse, HealthResponseSchema } from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = { health: "/health" } as const;

export interface DaemonSlice {
  health(): Promise<HealthResponse>;
}

export function daemonSlice(t: DaemonTransport): DaemonSlice {
  return {
    health(): Promise<HealthResponse> {
      return t.request({ path: fillPath(PATHS.health), schema: HealthResponseSchema });
    },
  };
}
