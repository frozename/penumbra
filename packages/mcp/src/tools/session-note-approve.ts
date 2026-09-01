import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import {
  SessionNoteApproveRequestSchema,
  SessionNoteApproveResponseSchema,
} from "@penumbra/api-contract";

import type { DaemonClient } from "../daemon-client.js";

export const SessionNoteApproveInputSchema = SessionNoteApproveRequestSchema;
export const SessionNoteApproveInputShape = SessionNoteApproveInputSchema.shape;

export function sessionNoteApproveHandler(
  daemon: Pick<DaemonClient, "sessionNoteApprove">,
): (input: unknown) => Promise<TextContentEnvelope> {
  return async (input): Promise<TextContentEnvelope> => {
    const parsed = SessionNoteApproveInputSchema.parse(input ?? {});
    const response = SessionNoteApproveResponseSchema.parse(
      await daemon.sessionNoteApprove(parsed),
    );
    return toTextContent(response);
  };
}
