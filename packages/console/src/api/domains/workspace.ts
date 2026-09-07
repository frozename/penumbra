import { type Workspace, WorkspaceSchema } from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = { get: "/workspace" } as const;

export interface WorkspaceSlice {
  get(): Promise<Workspace>;
}

export function workspaceSlice(t: DaemonTransport): WorkspaceSlice {
  return {
    get(): Promise<Workspace> {
      return t.request({ path: fillPath(PATHS.get), schema: WorkspaceSchema });
    },
  };
}
