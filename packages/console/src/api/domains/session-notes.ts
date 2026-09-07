import {
  type SessionNoteDraftsListResponse,
  SessionNoteDraftsListResponseSchema,
  type SessionNoteDraftStatus,
} from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = { drafts: "/session-notes/drafts" } as const;

export interface SessionNotesSlice {
  drafts(query?: {
    status?: SessionNoteDraftStatus;
    limit?: number;
  }): Promise<SessionNoteDraftsListResponse>;
}

export function sessionNotesSlice(t: DaemonTransport): SessionNotesSlice {
  return {
    drafts(query?: {
      status?: SessionNoteDraftStatus;
      limit?: number;
    }): Promise<SessionNoteDraftsListResponse> {
      return t.request({
        path: fillPath(PATHS.drafts),
        query,
        schema: SessionNoteDraftsListResponseSchema,
      });
    },
  };
}
