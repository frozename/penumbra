import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import {
  SessionNoteApproveRequestSchema,
  SessionNoteApproveResponseSchema,
} from "@penumbra/api-contract";

import type { DaemonClient } from "../daemon-client.js";

import { errorEnvelope } from "./error-envelope.js";

export const SessionNoteApproveInputSchema = SessionNoteApproveRequestSchema;
export const SessionNoteApproveInputShape = SessionNoteApproveInputSchema.shape;

export function sessionNoteApproveHandler(
  daemon: Pick<DaemonClient, "sessionNoteApprove">,
): (input: unknown) => Promise<TextContentEnvelope> {
  return async (input): Promise<TextContentEnvelope> => {
    const parsed = SessionNoteApproveInputSchema.parse(input ?? {});
    const responseBody = await daemon.sessionNoteApprove(parsed);
    const response = SessionNoteApproveResponseSchema.safeParse(responseBody);
    if (!response.success) {
      return errorEnvelope("session_note_approve", "invalid_response", response.error.message);
    }
    return toTextContent(response.data);
  };
}
