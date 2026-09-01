import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import {
  SessionNoteDraftsListResponseSchema,
  SessionNoteDraftsQuerySchema,
} from "@penumbra/api-contract";

import type { DaemonClient } from "../daemon-client.js";

import { errorEnvelope } from "./error-envelope.js";

export const SessionNoteDraftsInputSchema = SessionNoteDraftsQuerySchema;
export const SessionNoteDraftsInputShape = SessionNoteDraftsInputSchema.shape;

export function sessionNoteDraftsHandler(
  daemon: Pick<DaemonClient, "sessionNoteDrafts">,
): (input: unknown) => Promise<TextContentEnvelope> {
  return async (input): Promise<TextContentEnvelope> => {
    const parsed = SessionNoteDraftsInputSchema.parse(input ?? {});
    const responseBody = await daemon.sessionNoteDrafts(parsed);
    const response = SessionNoteDraftsListResponseSchema.safeParse(responseBody);
    if (!response.success) {
      return errorEnvelope("session_note_drafts", "invalid_response", response.error.message);
    }
    return toTextContent(response.data);
  };
}
