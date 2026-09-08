import {
  type SessionNoteApproveRequest,
  SessionNoteApproveRequestSchema,
  type SessionNoteApproveResponse,
  SessionNoteApproveResponseSchema,
  type SessionNoteDraftsListResponse,
  SessionNoteDraftsListResponseSchema,
  type SessionNoteDraftStatus,
} from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { DaemonContractError } from "../errors.js";
import { fillPath } from "../paths.js";

export const PATHS = {
  drafts: "/session-notes/drafts",
  approve: "/session-notes/approve",
} as const;

export interface SessionNotesSlice {
  drafts(query?: {
    status?: SessionNoteDraftStatus;
    limit?: number;
  }): Promise<SessionNoteDraftsListResponse>;
  approve(body: SessionNoteApproveRequest): Promise<SessionNoteApproveResponse>;
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
    async approve(body: SessionNoteApproveRequest): Promise<SessionNoteApproveResponse> {
      const parsed = SessionNoteApproveRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw new DaemonContractError({
          url: fillPath(PATHS.approve),
          issues: parsed.error.issues,
          rawBody: body,
        });
      }
      return await t.request({
        method: "POST",
        path: fillPath(PATHS.approve),
        body: parsed.data,
        schema: SessionNoteApproveResponseSchema,
      });
    },
  };
}
