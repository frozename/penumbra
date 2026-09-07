import { type MissionSession, MissionSessionSchema } from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = { current: "/session/current" } as const;

export interface SessionsSlice {
  current(): Promise<MissionSession>;
}

export function sessionsSlice(t: DaemonTransport): SessionsSlice {
  return {
    current(): Promise<MissionSession> {
      return t.request({ path: fillPath(PATHS.current), schema: MissionSessionSchema });
    },
  };
}
